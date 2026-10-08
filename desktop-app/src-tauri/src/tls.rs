//! Encrypted connections between devices.
//!
//! A device's identity is an Ed25519 key, which signs but cannot encrypt, so
//! each device makes a separate TLS key and has its identity vouch for it:
//! the certificate carries an extension holding the device's public key and
//! its signature over the certificate's own public key. A client that sees
//! that certificate knows, from the handshake alone, which device it is
//! talking to. No certificate authority, and nothing to store: the TLS key
//! is made fresh each time the app starts.
//!
//! What the client then requires depends on the call:
//!
//! - [`paired`] accepts only a device in the paired list. Everything that
//!   carries files or names goes through it.
//! - [`open`] accepts any device that proves the identity it claims. It is
//!   for discovery and pairing, where no trust exists yet; the 6-digit code
//!   is what establishes it.
//!
//! The server still identifies the *client* by the signed headers of
//! `pairing::middleware`, as before. TLS adds confidentiality and proves the
//! server; it does not replace that check.

use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};

use crate::pairing::DeviceStore;

/// The extension that carries a device's claim to a certificate: 32 bytes
/// of Ed25519 public key, then the 64-byte signature. Under 2.25, the arc
/// for identifiers nobody has to register. Kept in step with `Tls.kt`.
const ATTESTATION_OID: &[u64] = &[2, 25, 8_377_001];

/// What the identity key signs: this, then the certificate's
/// SubjectPublicKeyInfo. The prefix keeps the signature from meaning
/// anything in another context, such as a signed request.
const ATTESTATION_CONTEXT: &[u8] = b"lanclave-tls-v1:";

const KEY_LEN: usize = 32;
const SIG_LEN: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum AttestationError {
    /// Not a certificate we can read.
    Malformed,
    /// A certificate with no claim in it: not a LANclave device.
    Missing,
    /// The claim is not signed by the key it names.
    BadSignature,
}

impl std::fmt::Display for AttestationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Malformed => "the certificate could not be read",
            Self::Missing => "the certificate does not say which LANclave device it belongs to",
            Self::BadSignature => "the certificate is not signed by the device it claims to be",
        })
    }
}

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| Arc::new(rustls::crypto::ring::default_provider()))
        .clone()
}

// ---------------------------------------------------------------------------
// Making and reading certificates
// ---------------------------------------------------------------------------

/// A fresh TLS key and a certificate for it, vouched for by `identity`.
pub fn generate(
    identity: &SigningKey,
) -> Result<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>), String> {
    let key_pair = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;

    // The signature covers the public key exactly as the certificate encodes
    // it, so read those bytes back out of a certificate rather than trust
    // that the key pair serialises them the same way.
    let unsigned = certificate(&key_pair, None)?;
    let spki = subject_public_key_info(unsigned.as_ref()).map_err(|e| e.to_string())?;

    let mut claim = Vec::with_capacity(KEY_LEN + SIG_LEN);
    claim.extend_from_slice(identity.verifying_key().as_bytes());
    claim.extend_from_slice(&identity.sign(&[ATTESTATION_CONTEXT, &spki].concat()).to_bytes());

    let cert = certificate(&key_pair, Some(claim))?;
    Ok((cert, PrivatePkcs8KeyDer::from(key_pair.serialize_der())))
}

fn certificate(key_pair: &rcgen::KeyPair, claim: Option<Vec<u8>>) -> Result<CertificateDer<'static>, String> {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName, "LANclave");
    if let Some(claim) = claim {
        params
            .custom_extensions
            .push(rcgen::CustomExtension::from_oid_content(ATTESTATION_OID, claim));
    }
    let cert = params.self_signed(key_pair).map_err(|e| e.to_string())?;
    Ok(cert.der().clone())
}

fn subject_public_key_info(cert_der: &[u8]) -> Result<Vec<u8>, AttestationError> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).map_err(|_| AttestationError::Malformed)?;
    Ok(cert.tbs_certificate.subject_pki.raw.to_vec())
}

/// DER contents of an object identifier (without tag and length).
fn oid_bytes(arcs: &[u64]) -> Vec<u8> {
    let mut out = vec![(arcs[0] * 40 + arcs[1]) as u8];
    for &arc in &arcs[2..] {
        let mut groups = vec![(arc & 0x7f) as u8];
        let mut rest = arc >> 7;
        while rest > 0 {
            groups.push((rest & 0x7f) as u8 | 0x80);
            rest >>= 7;
        }
        out.extend(groups.iter().rev());
    }
    out
}

/// The device a certificate belongs to: the identity key in its claim, once
/// that key's signature over the certificate's own key has checked out.
pub fn attested_device(cert_der: &[u8]) -> Result<VerifyingKey, AttestationError> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).map_err(|_| AttestationError::Malformed)?;
    let wanted = oid_bytes(ATTESTATION_OID);
    let claim = cert
        .extensions()
        .iter()
        .find(|ext| ext.oid.as_bytes() == wanted.as_slice())
        .ok_or(AttestationError::Missing)?
        .value;
    if claim.len() != KEY_LEN + SIG_LEN {
        return Err(AttestationError::Malformed);
    }

    let key_bytes: [u8; KEY_LEN] = claim[..KEY_LEN].try_into().unwrap();
    let sig_bytes: [u8; SIG_LEN] = claim[KEY_LEN..].try_into().unwrap();
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| AttestationError::Malformed)?;

    let signed = [ATTESTATION_CONTEXT, cert.tbs_certificate.subject_pki.raw].concat();
    key.verify_strict(&signed, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| AttestationError::BadSignature)?;
    Ok(key)
}

// ---------------------------------------------------------------------------
// Whose certificate a client accepts
// ---------------------------------------------------------------------------

/// The paired list the [`paired`] client checks against, set once at launch.
static PAIRED_STORE: OnceLock<Arc<RwLock<DeviceStore>>> = OnceLock::new();

/// Tell the [`paired`] client which devices are paired. Until this is
/// called it accepts nobody.
pub fn set_paired_store(store: Arc<RwLock<DeviceStore>>) {
    let _ = PAIRED_STORE.set(store);
}

/// Which devices a client will talk to.
#[derive(Clone)]
pub enum Trust {
    /// Devices in the app's paired list.
    Paired,
    /// Devices in this list, for a test that brings its own.
    #[cfg(test)]
    Listed(Arc<RwLock<DeviceStore>>),
    /// Any device that proves the identity it claims.
    Anyone,
}

impl Trust {
    fn allows(&self, device: &VerifyingKey) -> bool {
        let listed = |store: &Arc<RwLock<DeviceStore>>| {
            let Ok(store) = store.read() else { return false };
            store
                .devices
                .keys()
                .any(|id| store.get_peer_key(id).is_some_and(|key| key == *device))
        };
        match self {
            Self::Anyone => true,
            #[cfg(test)]
            Self::Listed(store) => listed(store),
            Self::Paired => match PAIRED_STORE.get() {
                Some(store) => listed(store),
                // Tests run many servers with throwaway identities and no
                // app-wide list; proving the claimed identity is what they
                // exercise. The app itself fails closed.
                None => cfg!(test),
            },
        }
    }
}

struct PeerVerifier {
    trust: Trust,
    algorithms: WebPkiSupportedAlgorithms,
}

impl std::fmt::Debug for PeerVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PeerVerifier")
    }
}

impl ServerCertVerifier for PeerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        // Devices are reached by address, and an address proves nothing;
        // the claim inside the certificate is the identity.
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        // The certificate lives as long as the process that made it, and a
        // phone's clock may be wrong; there is no expiry worth enforcing.
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let device = attested_device(end_entity.as_ref()).map_err(|e| rustls::Error::General(e.to_string()))?;
        if !self.trust.allows(&device) {
            return Err(rustls::Error::General("that device is not paired with this one".into()));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

// ---------------------------------------------------------------------------
// Configurations and clients
// ---------------------------------------------------------------------------

/// TLS 1.3 server settings presenting a fresh certificate for `identity`.
pub fn server_config(identity: &SigningKey) -> Result<Arc<ServerConfig>, String> {
    let (cert, key) = generate(identity)?;
    let config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(vec![cert], PrivateKeyDer::Pkcs8(key))
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(config))
}

/// TLS 1.3 client settings that accept the devices `trust` allows.
pub fn client_config(trust: Trust) -> ClientConfig {
    let provider = provider();
    let verifier = PeerVerifier {
        trust,
        algorithms: provider.signature_verification_algorithms,
    };
    ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("the ring provider supports TLS 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth()
}

/// A `reqwest` builder whose connections accept the devices `trust` allows.
pub fn client_builder(trust: Trust) -> reqwest::ClientBuilder {
    reqwest::Client::builder().use_preconfigured_tls(client_config(trust))
}

fn default_client(trust: Trust) -> reqwest::Client {
    client_builder(trust)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("valid reqwest client config")
}

/// The client for paired devices: files, listings, offers, presence.
pub fn paired() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| default_client(Trust::Paired))
}

/// The client for devices not paired yet, or no longer: discovery, asking
/// to pair, and withdrawing a pairing. Never send it anything private.
pub fn open() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| default_client(Trust::Anyone))
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/// How long a connection may take over its TLS handshake before it is
/// dropped; a port scanner that connects and says nothing costs one task.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Serve `router` over TLS on `listener` until `shutdown` resolves.
///
/// Stopping closes the listener at once and lets requests already under way
/// (a download, an upload) finish; idle kept-alive connections are closed.
/// Each request carries the caller's address as `ConnectInfo`, taken from
/// the TCP connection itself, with no reliance on anything the peer claims.
pub async fn serve(
    listener: tokio::net::TcpListener,
    router: axum::Router,
    config: Arc<ServerConfig>,
    shutdown: impl std::future::Future<Output = ()>,
) {
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use hyper_util::server::conn::auto::Builder;
    use hyper_util::service::TowerToHyperService;

    let acceptor = tokio_rustls::TlsAcceptor::from(config);
    let (closing_tx, closing_rx) = tokio::sync::watch::channel(false);
    tokio::pin!(shutdown);

    loop {
        let (tcp, remote) = tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => match accepted {
                Ok(connection) => connection,
                Err(_) => {
                    // Out of file handles or the like: wait, do not spin.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
        };

        let acceptor = acceptor.clone();
        let service = router
            .clone()
            .layer(axum::Extension(axum::extract::ConnectInfo(remote)));
        let mut closing = closing_rx.clone();

        tokio::spawn(async move {
            let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await else {
                return;
            };
            let builder = Builder::new(TokioExecutor::new());
            let connection =
                builder.serve_connection_with_upgrades(TokioIo::new(tls), TowerToHyperService::new(service));
            tokio::pin!(connection);

            tokio::select! {
                _ = connection.as_mut() => {}
                _ = closing.changed() => {
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.await;
                }
            }
        });
    }

    drop(listener);
    let _ = closing_tx.send(true);
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    fn identity() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    fn store_with(keys: &[&SigningKey]) -> Arc<RwLock<DeviceStore>> {
        let mut store = DeviceStore::new();
        for key in keys {
            let id = crate::pairing::public_key_b64(key);
            store.add_peer(id, &key.verifying_key(), None).unwrap();
        }
        Arc::new(RwLock::new(store))
    }

    #[test]
    fn a_certificate_names_the_device_that_made_it() {
        let device = identity();
        let (cert, _) = generate(&device).unwrap();
        assert_eq!(attested_device(cert.as_ref()).unwrap(), device.verifying_key());
    }

    #[test]
    fn a_certificate_without_a_claim_is_not_a_lanclave_device() {
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let cert = certificate(&key_pair, None).unwrap();
        assert_eq!(attested_device(cert.as_ref()), Err(AttestationError::Missing));
    }

    #[test]
    fn a_claim_copied_onto_another_key_is_refused() {
        // An attacker lifts a real device's claim and puts it on a
        // certificate for a key the attacker holds.
        let device = identity();
        let (real, _) = generate(&device).unwrap();
        let (_, parsed) = x509_parser::parse_x509_certificate(real.as_ref()).unwrap();
        let wanted = oid_bytes(ATTESTATION_OID);
        let claim = parsed
            .extensions()
            .iter()
            .find(|ext| ext.oid.as_bytes() == wanted.as_slice())
            .unwrap()
            .value
            .to_vec();

        let attacker_key = rcgen::KeyPair::generate().unwrap();
        let forged = certificate(&attacker_key, Some(claim)).unwrap();
        assert_eq!(attested_device(forged.as_ref()), Err(AttestationError::BadSignature));
    }

    #[test]
    fn a_claim_signed_by_a_different_key_than_it_names_is_refused() {
        let named = identity();
        let signer = identity();
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let spki = subject_public_key_info(certificate(&key_pair, None).unwrap().as_ref()).unwrap();

        let mut claim = named.verifying_key().as_bytes().to_vec();
        claim.extend_from_slice(&signer.sign(&[ATTESTATION_CONTEXT, &spki].concat()).to_bytes());
        let cert = certificate(&key_pair, Some(claim)).unwrap();
        assert_eq!(attested_device(cert.as_ref()), Err(AttestationError::BadSignature));
    }

    #[test]
    fn garbage_is_not_a_certificate() {
        assert_eq!(attested_device(b"not a certificate"), Err(AttestationError::Malformed));
    }

    #[test]
    fn trust_follows_the_paired_list() {
        let friend = identity();
        let stranger = identity();
        let listed = Trust::Listed(store_with(&[&friend]));

        assert!(listed.allows(&friend.verifying_key()));
        assert!(!listed.allows(&stranger.verifying_key()));
        assert!(Trust::Anyone.allows(&stranger.verifying_key()));
    }

    /// A TLS server for `device` on a free port, answering `GET /` with "ok".
    async fn serve_as(device: &SigningKey) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = axum::Router::new().route("/", axum::routing::get(|| async { "ok" }));
        let config = server_config(device).unwrap();
        tokio::spawn(serve(listener, router, config, std::future::pending()));
        format!("https://{addr}/")
    }

    fn client(trust: Trust) -> reqwest::Client {
        client_builder(trust).build().unwrap()
    }

    #[tokio::test]
    async fn a_paired_device_is_reached_and_a_stranger_is_not() {
        let friend = identity();
        let stranger = identity();
        let trust = Trust::Listed(store_with(&[&friend]));

        let reply = client(trust.clone()).get(serve_as(&friend).await).send().await.unwrap();
        assert_eq!(reply.text().await.unwrap(), "ok");

        let refused = client(trust).get(serve_as(&stranger).await).send().await;
        assert!(refused.is_err(), "connected to a device that is not paired");
    }

    #[tokio::test]
    async fn the_open_client_reaches_any_lanclave_device() {
        let stranger = identity();
        let reply = client(Trust::Anyone).get(serve_as(&stranger).await).send().await.unwrap();
        assert_eq!(reply.text().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn nothing_is_served_in_the_clear() {
        let url = serve_as(&identity()).await.replace("https://", "http://");
        // Even a client willing to trust anyone gets nowhere without TLS.
        let plain = client(Trust::Anyone).get(url).send().await;
        assert!(plain.is_err(), "the server answered a plain HTTP request");
    }
}
