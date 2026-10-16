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
import java.net.HttpURLConnection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

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
 *
 * Threads: the WebRTC objects and the fields beside them belong to
 * [worker]; WebRTC's own callbacks only hand over to it, because disposing a
 * connection from inside its callback deadlocks. Asking the laptop runs on
 * [requests], so Stop never waits behind a prompt someone is still reading.
 * Each start and stop bumps [run]; work begun for an earlier run sees that
 * and gives up.
 */
object Mirror {
    /** The laptop's user has a minute to answer; give the request a little more. */
    private const val ASK_TIMEOUT_MS = 70_000
    private const val FPS = 30
    /** How long a dropped connection may take to come back before sharing ends. */
    private const val RECONNECT_GRACE_MS = 5_000L

    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val requests = Executors.newCachedThreadPool()

    @Volatile var state: String = "idle"
        private set
    @Volatile private var peerId: String? = null
    @Volatile private var peerName: String? = null

    fun peerNameForNotification(): String = peerName ?: "a paired laptop"

    private val run = AtomicInteger()
    /** The request to the laptop in flight, so Stop can cut it off. */
    @Volatile private var inFlight: HttpURLConnection? = null

    // ---- Worker only -------------------------------------------------------
    private var appContext: Context? = null
    private var peerAddr: String? = null
    private var sessionId: String? = null
    private var consent: Intent? = null
    private var serviceUp = false
    private var accepted = false
    private var grace: ScheduledFuture<*>? = null

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
        MirrorService.refresh()
    }

    /**
     * Ask `addr` to show this screen, with the capture permission the user
     * just granted (`consentData`, from Android's own prompt). Called while
     * LANclave is in front, which is when Android lets the capture service
     * start; it waits in "asking" until the laptop's user says yes.
     */
    fun start(context: Context, consentData: Intent, peerId: String, peerAddr: String, peerName: String?) {
        if (state != "idle") return
        val current = run.incrementAndGet()
        this.peerId = peerId
        this.peerName = peerName
        worker.execute {
            appContext = context.applicationContext
            this.peerAddr = peerAddr
            consent = consentData
        }
        report("asking")
        try {
            MirrorService.start(context)
        } catch (e: Exception) {
            worker.execute { finish(current, "failed", "Android did not let screen sharing start.") }
            return
        }
        requests.execute { ask(current, peerAddr) }
    }

    private fun ask(current: Int, addr: String) {
        val reply = send(addr, "/api/mirror/sessions", "{}", ASK_TIMEOUT_MS)
        val session = if (reply.status == 200) {
            try { JSONObject(reply.body).getString("session_id") } catch (_: Exception) { null }
        } else null
        val name = peerName ?: "The laptop"
        worker.execute {
            if (run.get() != current) {
                // Stopped while the laptop was deciding, and it said yes.
                if (session != null) tellLaptopStopped(addr, session)
                return@execute
            }
            when (reply.status) {
                200 -> if (session == null) {
                    finish(current, "failed", "The laptop answered oddly. Update LANclave there.")
                } else {
                    sessionId = session
                    accepted = true
                    report("connecting")
                    maybeConnect(current)
                }
                403 -> finish(current, "declined", "$name declined.")
                408 -> finish(current, "declined", "Nobody answered on ${peerName ?: "the laptop"}.")
                404 -> finish(current, "failed", "$name cannot show screens.")
                409 -> finish(current, "failed", "$name is still showing an earlier request from this phone. Answer it there first.")
                429 -> {
                    // Declined recently: it says how long to wait, and the wait grows.
                    val wait = try { JSONObject(reply.body).optLong("retry_after_secs") } catch (_: Exception) { 0L }
                    finish(
                        current, "declined",
                        if (wait > 0) "$name declined recently. You can ask again in ${waitPhrase(wait)}."
                        else "$name is not taking requests right now. Try again in a few seconds.",
                    )
                }
                else -> finish(current, "failed", "Could not reach ${peerName ?: "the laptop"}.")
            }
        }
    }

    /** "40 seconds", "2 minutes", "30 minutes". */
    fun waitPhrase(secs: Long): String = when {
        secs < 60 -> "$secs second${if (secs == 1L) "" else "s"}"
        else -> ((secs + 59) / 60).let { "$it minute${if (it == 1L) "" else "s"}" }
    }

    /** From [MirrorService], now in the foreground. */
    fun serviceStarted() {
        worker.execute {
            // Stopped before the service got going: it has nothing to do.
            if (state == "idle") return@execute MirrorService.stop()
            serviceUp = true
            maybeConnect(run.get())
        }
    }

    /** From [MirrorService]: Android refused to put it in the foreground. */
    fun serviceFailed() {
        worker.execute { finish(run.get(), "failed", "Android did not let screen sharing start.") }
    }

    /** Capture begins once the laptop said yes and the service is in the foreground. */
    private fun maybeConnect(current: Int) {
        if (!serviceUp || !accepted || pc != null || run.get() != current) return
        val context = appContext ?: return
        val data = consent ?: return finish(current, "failed", "Screen capture was not allowed.")
        try {
            connect(current, context, data)
        } catch (e: Exception) {
            finish(current, "failed", "Could not start sharing: ${e.message}")
        }
    }

    private fun connect(current: Int, context: Context, data: Intent) {
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
        val couldNot = "Could not start sharing."

        val metrics = context.resources.displayMetrics
        val (width, height) = MirrorSize.fit(metrics.widthPixels, metrics.heightPixels)

        val capturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            // The user revoked it from the system UI, or the screen locked
            // for good. Not when teardown stopped it: that run is over.
            override fun onStop() {
                if (run.get() == current) stop()
            }
        })
        val helper = SurfaceTextureHelper.create("lanclave-mirror", egl!!.eglBaseContext)
        val source = factory.createVideoSource(true)
        this.capturer = capturer
        this.helper = helper
        this.source = source
        capturer.initialize(helper, context, source.capturerObserver)
        capturer.startCapture(width, height, FPS)
        val track = factory.createVideoTrack("screen", source)
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
                worker.execute { connectionChanged(current, state) }
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
        }) ?: return finish(current, "failed", couldNot)
        this.pc = pc
        pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("screen")))

        val offer = awaitSdp { observer -> pc.createOffer(observer, MediaConstraints()) }
            ?: return finish(current, "failed", couldNot)
        awaitSet { observer -> pc.setLocalDescription(observer, offer) } ?: return finish(current, "failed", couldNot)
        // On a LAN every address is known within a moment: send them all at once.
        gathered.await(3, TimeUnit.SECONDS)
        if (run.get() != current) return

        val local = pc.localDescription?.description ?: return finish(current, "failed", couldNot)
        val reply = send(
            peerAddr ?: return finish(current, "failed", "No laptop to share with."),
            "/api/mirror/sessions/$sessionId/offer", JSONObject().put("sdp", local).toString(), 25_000,
        )
        if (run.get() != current) return
        val answer = try { JSONObject(reply.body).getString("sdp") } catch (_: Exception) { null }
        if (reply.status != 200 || answer == null) return finish(current, "failed", "The laptop did not start showing the screen.")
        awaitSet { observer -> pc.setRemoteDescription(observer, SessionDescription(SessionDescription.Type.ANSWER, answer)) }
            ?: return finish(current, "failed", "The laptop's answer could not be used.")
    }

    private fun connectionChanged(current: Int, next: PeerConnection.PeerConnectionState) {
        if (run.get() != current) return
        when (next) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                grace?.cancel(false)
                grace = null
                report("sharing")
            }
            PeerConnection.PeerConnectionState.FAILED -> finish(current, "failed", "The connection to the laptop was lost.")
            PeerConnection.PeerConnectionState.CLOSED -> finish(current, "ended")
            // Closing the window there looks like this too; a Wi-Fi blip
            // passes within the grace period.
            PeerConnection.PeerConnectionState.DISCONNECTED -> if (grace == null) {
                grace = worker.schedule({
                    grace = null
                    if (run.get() == current && pc?.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED) {
                        finish(current, "ended")
                    }
                }, RECONNECT_GRACE_MS, TimeUnit.MILLISECONDS)
            }
            else -> {}
        }
    }

    /** Stop sharing, from any thread; tells the laptop. Takes effect at once. */
    fun stop() {
        if (state == "idle") return
        val ended = run.incrementAndGet()
        // A prompt still up on the laptop closes when its request goes.
        inFlight?.disconnect()
        report("ended")
        state = "idle"
        worker.execute { teardown(ended) }
    }

    /** End run `current` from the worker, unless something already has. */
    private fun finish(current: Int, next: String, message: String? = null) {
        if (run.get() != current) return
        val ended = run.incrementAndGet()
        teardown(ended)
        report(next, message)
        state = "idle"
    }

    /** Release everything run `ended - 1` held. Worker only. */
    private fun teardown(ended: Int) {
        val addr = peerAddr
        val session = sessionId
        release()
        consent = null
        sessionId = null
        accepted = false
        serviceUp = false
        // A new share may already have started and be using the service.
        if (run.get() == ended) MirrorService.stop()
        if (addr != null && session != null) tellLaptopStopped(addr, session)
    }

    private fun tellLaptopStopped(addr: String, session: String) {
        requests.execute {
            PeerHttp.request(addr, "POST", "/api/mirror/sessions/$session/stop", "{}", Tls.Trust.PAIRED, true, 5_000)
        }
    }

    private fun send(addr: String, path: String, body: String, timeoutMs: Int): PeerHttp.Reply {
        var conn: HttpURLConnection? = null
        try {
            return PeerHttp.request(addr, "POST", path, body, Tls.Trust.PAIRED, true, timeoutMs) {
                conn = it
                inFlight = it
            }
        } finally {
            if (inFlight === conn) inFlight = null
        }
    }

    private fun release() {
        grace?.cancel(false)
        grace = null
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
