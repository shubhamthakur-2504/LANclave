package expo.modules.nativeserver

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The size to capture at: the screen's shape, at most [MAX_EDGE] on its long side. */
object MirrorSize {
    const val MAX_EDGE = 1920

    fun fit(width: Int, height: Int): Pair<Int, Int> {
        val scale = minOf(1.0, MAX_EDGE.toDouble() / maxOf(width, height))
        // Encoders want even dimensions.
        fun even(n: Double) = (n.toInt() / 2) * 2
        return even(width * scale) to even(height * scale)
    }
}

/**
 * Showing this phone's screen in a window on a paired laptop (`mirror.rs`).
 *
 * The video is WebRTC straight to that window. Setup goes over the paired
 * TLS API: ask (the laptop's user says yes or no), then one offer whose
 * reply is the answer. Nothing has to reach the phone, so this works with
 * its server off. Capture runs in [MirrorService], a foreground service of
 * the media-projection type, so it keeps going while the app being shown
 * is in front and LANclave is not. View-only.
 */
object Mirror {
    /** The laptop's user has a minute to answer; give the request a little more. */
    private const val ASK_TIMEOUT_MS = 70_000
    private const val FPS = 30

    private val worker = Executors.newSingleThreadExecutor()

    @Volatile var state: String = "idle"
        private set
    @Volatile private var peerName: String? = null

    fun peerNameForNotification(): String = peerName ?: "a paired laptop"

    private var peerId: String? = null
    private var peerAddr: String? = null
    private var sessionId: String? = null
    private var consent: Intent? = null

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var pc: PeerConnection? = null

    private fun report(next: String, message: String? = null) {
        state = next
        Events.emit("onMirrorState", mapOf("state" to next, "peerId" to peerId, "peerName" to peerName, "message" to message))
    }

    /**
     * Ask `addr` to show this screen, with the capture permission the user
     * just granted (`consentData`, from Android's own prompt).
     */
    fun start(context: Context, consentData: Intent, peerId: String, peerAddr: String, peerName: String?) {
        if (state != "idle" && state != "ended") return
        this.peerId = peerId
        this.peerAddr = peerAddr
        this.peerName = peerName
        consent = consentData
        report("asking")
        worker.execute {
            val reply = PeerHttp.request(peerAddr, "POST", "/api/mirror/sessions", "{}", Tls.Trust.PAIRED, true, ASK_TIMEOUT_MS)
            when (reply.status) {
                200 -> {
                    sessionId = try { JSONObject(reply.body).getString("session_id") } catch (_: Exception) { null }
                    if (sessionId == null) return@execute fail("The laptop answered oddly. Update LANclave there.")
                    report("connecting")
                    // Capture may only begin inside a media-projection
                    // foreground service; it calls back into [beginCapture].
                    MirrorService.start(context)
                }
                403 -> finish("declined", "${peerName ?: "The laptop"} declined.")
                408 -> finish("declined", "Nobody answered on ${peerName ?: "the laptop"}.")
                404 -> fail("${peerName ?: "That device"} cannot show screens.")
                else -> fail("Could not reach ${peerName ?: "the laptop"}.")
            }
        }
    }

    /** From [MirrorService], now in the foreground: start capturing and connect. */
    fun beginCapture(context: Context) {
        val data = consent ?: return fail("Screen capture was not allowed.")
        worker.execute {
            try {
                connect(context.applicationContext, data)
            } catch (e: Exception) {
                fail("Could not start sharing: ${e.message}")
            }
        }
    }

    private fun connect(context: Context, data: Intent) {
        if (factory == null) {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
            egl = EglBase.create()
            factory = PeerConnectionFactory.builder()
                // Hardware encoders where the phone has them: cooler and faster.
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
                .createPeerConnectionFactory()
        }
        val factory = factory!!

        val metrics = context.resources.displayMetrics
        val (width, height) = MirrorSize.fit(metrics.widthPixels, metrics.heightPixels)

        val capturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            // The user revoked it from the system UI, or the screen locked for good.
            override fun onStop() = stop()
        })
        val helper = SurfaceTextureHelper.create("lanclave-mirror", egl!!.eglBaseContext)
        val source = factory.createVideoSource(true)
        capturer.initialize(helper, context, source.capturerObserver)
        capturer.startCapture(width, height, FPS)
        val track = factory.createVideoTrack("screen", source)
        this.capturer = capturer
        this.helper = helper
        this.source = source
        this.track = track

        val gathered = CountDownLatch(1)
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        val pc = factory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown()
            }
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                when (state) {
                    PeerConnection.PeerConnectionState.CONNECTED -> report("sharing")
                    PeerConnection.PeerConnectionState.FAILED -> fail("The connection to the laptop was lost.")
                    PeerConnection.PeerConnectionState.DISCONNECTED,
                    PeerConnection.PeerConnectionState.CLOSED -> if (Mirror.state == "sharing") stop()
                    else -> {}
                }
            }
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceCandidate(candidate: IceCandidate) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: org.webrtc.DataChannel) {}
            override fun onRenegotiationNeeded() {}
        }) ?: return fail("Could not start sharing.")
        this.pc = pc
        pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("screen")))

        val offer = awaitSdp { observer -> pc.createOffer(observer, MediaConstraints()) }
            ?: return fail("Could not start sharing.")
        awaitSet { observer -> pc.setLocalDescription(observer, offer) } ?: return fail("Could not start sharing.")
        // On a LAN every address is known within a moment: send them all at once.
        gathered.await(3, TimeUnit.SECONDS)

        val local = pc.localDescription?.description ?: return fail("Could not start sharing.")
        val reply = PeerHttp.request(
            peerAddr ?: return fail("No laptop to share with."),
            "POST", "/api/mirror/sessions/$sessionId/offer",
            JSONObject().put("sdp", local).toString(), Tls.Trust.PAIRED, true, 25_000,
        )
        val answer = try { JSONObject(reply.body).getString("sdp") } catch (_: Exception) { null }
        if (reply.status != 200 || answer == null) return fail("The laptop did not start showing the screen.")
        awaitSet { observer -> pc.setRemoteDescription(observer, SessionDescription(SessionDescription.Type.ANSWER, answer)) }
            ?: return fail("The laptop's answer could not be used.")
    }

    /** Stop sharing, from either side; tells the laptop when it was this side. */
    fun stop() {
        val addr = peerAddr
        val session = sessionId
        worker.execute {
            if (addr != null && session != null) {
                PeerHttp.request(addr, "POST", "/api/mirror/sessions/$session/stop", "{}", Tls.Trust.PAIRED, true, 5_000)
            }
            release()
            if (state != "idle") finish("ended", null)
        }
    }

    private fun fail(message: String) {
        release()
        finish("failed", message)
    }

    private fun finish(next: String, message: String?) {
        consent = null
        sessionId = null
        MirrorService.stop()
        report(next, message)
        state = "idle"
    }

    private fun release() {
        try { capturer?.stopCapture() } catch (_: Exception) {}
        capturer?.dispose()
        pc?.dispose()
        track?.dispose()
        source?.dispose()
        helper?.dispose()
        capturer = null
        pc = null
        track = null
        source = null
        helper = null
    }

    // ---- Waiting on WebRTC's callbacks from the worker thread ------------

    private fun awaitSdp(call: (SdpObserver) -> Unit): SessionDescription? {
        val done = CountDownLatch(1)
        var result: SessionDescription? = null
        call(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) { result = sdp; done.countDown() }
            override fun onCreateFailure(error: String?) { done.countDown() }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String?) {}
        })
        done.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun awaitSet(call: (SdpObserver) -> Unit): Unit? {
        val done = CountDownLatch(1)
        var ok = false
        call(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {}
            override fun onCreateFailure(error: String?) {}
            override fun onSetSuccess() { ok = true; done.countDown() }
            override fun onSetFailure(error: String?) { done.countDown() }
        })
        done.await(10, TimeUnit.SECONDS)
        return if (ok) Unit else null
    }
}
