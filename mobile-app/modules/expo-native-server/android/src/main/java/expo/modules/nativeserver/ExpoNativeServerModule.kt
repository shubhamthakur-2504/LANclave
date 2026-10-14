package expo.modules.nativeserver

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class ExpoNativeServerModule : Module() {
  private var server: NativeServer? = null

  /** The newest pairing request, until JS shows it. */
  @Volatile private var pendingRequest: Map<String, Any?>? = null

  /** Pairing cancels not yet applied to the JS-side paired list. */
  private val pendingCancels = mutableSetOf<String>()

  /** Identity of the running server, so a redundant start can be detected. */
  private var currentConfig: String? = null

  /** Requests JS makes to other devices; they block, so not on the module's own thread. */
  private val requests = Executors.newCachedThreadPool()

  /** The subnet sweep: many short probes, most of them to addresses nobody is at. */
  private val probes = Executors.newFixedThreadPool(64)

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeServer")

    Events(
      "onPairingCancelled",
      "onPairingRequest",
      "onTransferProgress",
      "onOffersChanged",
      "onOfferReceived",
      "onOfferProgress",
      "onMessagesChanged",
    )

    OnCreate {
      // Native transfers and offers talk to JS through here.
      Events.sink = { name, body -> sendEvent(name, body) }
    }

    /**
     * The key native requests are signed with (P4): the same seed JS signs
     * with, kept in memory only. Called before the server starts.
     */
    Function("setIdentity") { deviceId: String, seedHex: String ->
      Identity.set(deviceId, seedHex)
    }

    // ---- Transfers (native engine) ----------------------------------

    AsyncFunction("pull") { peerAddr: String, peerId: String, peerName: String?, remoteName: String, size: Double? ->
      TransferEngine.pullFromSandbox(peerAddr, peerId, peerName, remoteName, size?.toLong())
    }
    Function("pauseTransfer") { id: String -> TransferEngine.pause(id) }
    Function("resumeTransfer") { id: String -> TransferEngine.resume(id) }
    Function("cancelTransfer") { id: String -> TransferEngine.cancel(id) }
    /** Forget a failed or paused download and its partial file. */
    Function("removeTransfer") { id: String -> TransferEngine.remove(id) }
    Function("getTransfers") { TransferEngine.snapshot() }
    /** Downloads that run at once (1-8, default 2); kept across restarts. */
    Function("getMaxDownloads") { TransferEngine.maxDownloads }
    Function("setMaxDownloads") { n: Int -> TransferEngine.maxDownloads = n }

    /** Devices whose offers are taken without asking (P5). */
    Function("getAutoAccept") {
      val context = appContext.reactContext ?: return@Function emptyList<String>()
      Offers.autoAccept(context).toList()
    }
    Function("setAutoAccept") { deviceId: String, enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      Offers.setAutoAccept(context, deviceId, enabled)
    }

    // ---- Opening files (O1) -------------------------------------------

    /** "Open with" for a content URI; false when no app opens this type. */
    Function("openUri") { uri: String, name: String ->
      val ctx = appContext.currentActivity ?: appContext.reactContext ?: throw Exception("React context is null")
      OpenFiles.open(ctx, uri, name)
    }
    Function("shareUri") { uri: String, name: String ->
      val ctx = appContext.currentActivity ?: appContext.reactContext ?: throw Exception("React context is null")
      OpenFiles.share(ctx, uri, name)
    }
    Function("isRiskyFile") { name: String -> OpenFiles.isRisky(name) }

    // ---- Offers --------------------------------------------------------

    Function("listOffers") { Offers.snapshotJson() }

    /** Offer files; resolves to the offer id, or null if the peer predates offers. */
    AsyncFunction("sendFiles") { peerAddr: String, peerId: String, peerName: String?, filesJson: String ->
      Offers.send(peerAddr, peerId, peerName, org.json.JSONArray(filesJson))
    }
    AsyncFunction("acceptOffer") { offerId: String, fileIds: List<String> -> Offers.accept(offerId, fileIds) }
    AsyncFunction("declineOffer") { offerId: String -> Offers.decline(offerId) }
    AsyncFunction("cancelOffer") { offerId: String -> Offers.cancelOutgoing(offerId) }
    Function("pauseOffer") { offerId: String, paused: Boolean -> Offers.pauseOutgoing(offerId, paused) }

    Function("startServer") { port: Int, deviceId: String, deviceName: String, sandboxPath: String, pairedDevices: Array<String> ->
      try {
        val config = "$port|$deviceId|$deviceName|$sandboxPath"
        val existing = server

        // Idempotent. This used to stop() and rebuild unconditionally, and the
        // JS watchdog calls it every 10s, so the listening socket was torn down
        // and rebound every 10 seconds -- resetting every peer's TCP connection
        // and killing any transfer in flight. A start for a server that is
        // already listening with the same config is now just a paired-device
        // refresh.
        appContext.reactContext?.let { Offers.keepAutoAcceptFor(it, pairedDevices.toList()) }
        Tls.setPairedDevices(pairedDevices.toList())
        if (existing != null && existing.isAlive && currentConfig == config) {
          existing.updatePairedDevices(pairedDevices.toList())
          return@Function true
        }

        existing?.stop()
        val context = appContext.reactContext ?: throw Exception("React context is null")
        val next = NativeServer(context, port, deviceId, deviceName, sandboxPath, pairedDevices.toList()) { cancelledId ->
          // Queued as well as announced: the stored paired list lives in JS,
          // and a cancel must not be lost if nothing is listening right now.
          synchronized(pendingCancels) { pendingCancels.add(cancelledId) }
          sendEvent("onPairingCancelled", mapOf("deviceId" to cancelledId))
        }.also { srv ->
          srv.setPairingRequestHandler { id, name, ip, code ->
            val request = mapOf(
              "deviceId" to id,
              "name" to name,
              "ip" to ip,
              "fingerprint" to code,
              "receivedAtMs" to System.currentTimeMillis().toDouble(),
            )
            // Kept too, so a dialog is not lost while nothing is listening.
            pendingRequest = request
            sendEvent("onPairingRequest", request)
          }
        }
        // TLS 1.3 only, with the certificate the identity key vouches for.
        next.makeSecure(Tls.serverSocketFactory(), arrayOf("TLSv1.3"))
        next.start(5000, false)
        // Offers first: downloads restored from last time report to them.
        Offers.configure(context, sandboxPath, deviceName)
        TransferEngine.configure(context, sandboxPath)
        server = next
        currentConfig = config
        LocalNetwork.holdMulticast(context)
        true
      } catch (e: Exception) {
        server = null
        currentConfig = null
        throw Exception("Failed to start server: ${e.message}")
      }
    }

    // ---- Requests to other devices, for JS --------------------------------
    //
    // `fetch` cannot check a certificate like ours, so every call JS makes
    // to another device goes through here.

    /**
     * One request. `anyone` is for discovery and pairing, where the other
     * device is not paired yet; everything else reaches paired devices only.
     * Resolves to `{ status, body }`; status is -1 when nothing answered.
     */
    AsyncFunction("peerRequest") { addr: String, method: String, path: String, body: String?, anyone: Boolean, signed: Boolean, timeoutMs: Int, promise: Promise ->
      requests.execute {
        val trust = if (anyone) Tls.Trust.ANYONE else Tls.Trust.PAIRED
        val reply = PeerHttp.request(addr, method, path, body, trust, signed, timeoutMs)
        promise.resolve(mapOf("status" to reply.status, "body" to reply.body))
      }
    }

    /**
     * Ask each address for `/health` at once; resolves to the bodies of the
     * ones that answered, by address. The sweep that finds unpaired devices.
     */
    AsyncFunction("probeHealth") { addrs: List<String>, timeoutMs: Int, promise: Promise ->
      val found = java.util.concurrent.ConcurrentHashMap<String, String>()
      val pending = java.util.concurrent.CountDownLatch(addrs.size)
      for (addr in addrs) {
        probes.execute {
          try {
            val reply = PeerHttp.request(addr, "GET", "/health", null, Tls.Trust.ANYONE, false, timeoutMs)
            if (reply.status == 200) found[addr] = reply.body
          } finally {
            pending.countDown()
          }
        }
      }
      requests.execute {
        pending.await()
        promise.resolve(found.toMap())
      }
    }

    // ---- Messages -----------------------------------------------------------

    /** Write a message; it goes now if `peerAddr` answers, else on the next contact. */
    Function("sendMessage") { peerId: String, peerAddr: String?, text: String ->
      appContext.reactContext?.let { Messages.configure(it) }
      val message = try {
        Messages.queueOutgoing(peerId, text)
      } catch (e: IllegalArgumentException) {
        throw Exception(e.message)
      }
      if (!peerAddr.isNullOrEmpty()) Messages.onContact(peerId, peerAddr, 0)
      Messages.toMap(message)
    }
    Function("getThread") { peerId: String ->
      appContext.reactContext?.let { Messages.configure(it) }
      Messages.thread(peerId).map { Messages.toMap(it) }
    }
    Function("listThreads") {
      appContext.reactContext?.let { Messages.configure(it) }
      Messages.summaries()
    }
    Function("markThreadRead") { peerId: String -> Messages.markRead(peerId) }
    Function("clearThread") { peerId: String -> Messages.forget(peerId) }
    /** A paired device answered: deliver to it, and fetch what it holds for us. */
    Function("messagesContact") { peerId: String, peerAddr: String, waitingThere: Int ->
      appContext.reactContext?.let { Messages.configure(it) }
      Messages.onContact(peerId, peerAddr, waitingThere)
    }
    /**
     * Copy text, marked sensitive: Android's clipboard preview then hides
     * it, which matters for a code copied while the screen is shared.
     */
    Function("copyText") { text: String ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
      val clip = android.content.ClipData.newPlainText("LANclave", text)
      clip.description.extras = android.os.PersistableBundle().apply {
        putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
      }
      clipboard.setPrimaryClip(clip)
    }

    // ---- Blocked devices --------------------------------------------------

    /** Refuse every future pairing request from this device. */
    Function("blockDevice") { deviceId: String, deviceName: String? ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      BlockList.shared(context).block(deviceId, deviceName)
    }
    Function("unblockDevice") { deviceId: String ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      BlockList.shared(context).unblock(deviceId)
    }
    Function("listBlocked") {
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any?>>()
      BlockList.shared(context).list().map {
        mapOf("deviceId" to it.deviceId, "deviceName" to it.deviceName, "blockedAtMs" to it.blockedAtMs.toDouble())
      }
    }

    Function("isRunning") {
      server?.isAlive == true
    }

    /**
     * URIs handed to us by Android's share sheet (U3.2).
     *
     * Returns the EXTRA_STREAM of an ACTION_SEND / ACTION_SEND_MULTIPLE
     * intent, then clears the intent so the same share is not replayed every
     * time the app is foregrounded. Content URIs are returned as-is: the
     * uploader reads content:// directly, so nothing needs copying first.
     */
    Function("consumeSharedUris") {
      val activity = appContext.currentActivity
      val intent = activity?.intent
      val action = intent?.action

      if (intent == null ||
        (action != android.content.Intent.ACTION_SEND &&
          action != android.content.Intent.ACTION_SEND_MULTIPLE)
      ) {
        return@Function emptyList<String>()
      }

      val uris = when (action) {
        android.content.Intent.ACTION_SEND -> {
          // minSdk is 33, so the typed getter always exists.
          val uri = intent.getParcelableExtra(
            android.content.Intent.EXTRA_STREAM,
            android.net.Uri::class.java,
          )
          listOfNotNull(uri)
        }
        else -> {
          val list = intent.getParcelableArrayListExtra(
            android.content.Intent.EXTRA_STREAM,
            android.net.Uri::class.java,
          )
          list ?: emptyList()
        }
      }

      // Consume it: a share should be handled once, not on every resume.
      intent.action = android.content.Intent.ACTION_MAIN
      intent.removeExtra(android.content.Intent.EXTRA_STREAM)

      uris.map { it.toString() }
    }

    /**
     * Dedupe, client side: size and (when it matches `expectedSize`) SHA-256
     * of a file in our own sandbox, plus same-size numbered copies. Null when
     * the file is absent.
     */
    AsyncFunction("sandboxFileFingerprint") { sandboxPath: String, name: String, expectedSize: Double? ->
      if (name.contains("..") || name.contains("/") || name.isEmpty()) return@AsyncFunction null
      val context = appContext.reactContext ?: throw Exception("React context is null")
      val result = Fingerprint.ofSandboxFile(context, sandboxPath, name, expectedSize?.toLong())
        ?: return@AsyncFunction null
      mapOf(
        "size" to result.size.toDouble(),
        "sha256" to result.sha256,
        "siblings" to result.siblings.map { mapOf("name" to it.name, "sha256" to it.sha256) },
      )
    }

    /** SHA-256 of a local file about to be pushed, e.g. a picked content:// URI. */
    AsyncFunction("uriSha256") { uri: String ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      Fingerprint.ofUri(context, uri)
    }

    /**
     * Transfer history (30 days). The server logs what peers do; JS logs the
     * transfers it starts with `recordTransfer` (a JSON entry, same fields as
     * the desktop's `HistoryEntry`).
     */
    AsyncFunction("recordTransfer") { json: String ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      TransferHistory.record(context, org.json.JSONObject(json))
    }

    /** JSON array string, newest first. */
    AsyncFunction("getTransferHistory") {
      val context = appContext.reactContext ?: throw Exception("React context is null")
      TransferHistory.list(context)
    }

    AsyncFunction("clearTransferHistory") {
      val context = appContext.reactContext ?: throw Exception("React context is null")
      TransferHistory.clear(context)
    }

    /** The last pairing request not yet shown, if under a minute old; consumed on read. */
    Function("consumePairingRequest") {
      val request = pendingRequest
      pendingRequest = null
      val at = (request?.get("receivedAtMs") as? Double) ?: 0.0
      request?.takeIf { System.currentTimeMillis() - at < 60_000 }
    }

    /** Devices that withdrew their pairing since the last call; consumed on read. */
    Function("consumePairingCancels") {
      synchronized(pendingCancels) {
        val out = pendingCancels.toList()
        pendingCancels.clear()
        out
      }
    }

    /** Inbound presence recorded by the server. Local read, no network. */
    Function("getPresence") {
      PresenceRegistry.snapshot()
    }

    Function("stopServer") {
      server?.stop()
      server = null
      currentConfig = null
      LocalNetwork.releaseMulticast()
    }

    // ---- Pairing guard: one ceremony at a time, rejections mute ---------

    /** Our code is on screen for a pairing started here; others wait. */
    Function("beginOutgoingPairing") { deviceId: String -> PairingGuard.shared.beginOutgoing(deviceId) }
    /** The user rejected the codes; a device that asked us is muted a while. */
    Function("declinePairing") { deviceId: String -> PairingGuard.shared.decline(deviceId) }
    /** Paired: forgive the device and free the screen. */
    Function("pairingConfirmed") { deviceId: String -> PairingGuard.shared.paired(deviceId) }

    /** Private IPv4s on Wi-Fi, hotspot, USB or Ethernet; the scan sweeps their /24s. */
    Function("getLocalIpv4Addresses") { LocalNetwork.ipv4Addresses() }

    Function("updatePairedDevices") { devices: Array<String> ->
      appContext.reactContext?.let { Offers.keepAutoAcceptFor(it, devices.toList()) }
      Tls.setPairedDevices(devices.toList())
      server?.updatePairedDevices(devices.toList())
    }
  }
}
