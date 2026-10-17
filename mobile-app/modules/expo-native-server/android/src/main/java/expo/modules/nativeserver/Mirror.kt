package expo.modules.nativeserver

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.util.Log
import org.json.JSONObject
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.CapturerObserver
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.HardwareVideoEncoderFactory
import org.webrtc.IceCandidate
import org.webrtc.IceCandidateErrorEvent
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStats
import org.webrtc.RtpParameters
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.net.HttpURLConnection
import java.net.NetworkInterface
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

/** Picture quality on a LAN, where there is bandwidth to spare. */
object MirrorTuning {
    const val START_KBPS = 4_000
    const val MIN_KBPS = 1_000
    const val MAX_KBPS = 10_000
    /** Hardware codecs, best first: H.264 is decoded in hardware on the laptop too. */
    private val HARDWARE_ORDER = listOf("H264", "VP8", "VP9", "AV1")

    /**
     * `codecs` with the ones this phone encodes in hardware first, H.264
     * ahead. WebRTC's default is VP8, often software on phones: hotter,
     * slower and blurrier. The rest keep their order.
     */
    fun <T> hardwareFirst(codecs: List<T>, name: (T) -> String, hardware: Set<String>): List<T> =
        codecs.sortedBy { codec ->
            val n = name(codec)
            if (n in hardware && n in HARDWARE_ORDER) HARDWARE_ORDER.indexOf(n) else HARDWARE_ORDER.size
        }

    /**
     * The laptop's answer with WebRTC's bitrate hints on each video codec.
     * Without them sending starts near 300 kbps and takes seconds to climb:
     * a blurry start on a network that could carry far more from the first frame.
     */
    fun withBitrates(sdp: String): String {
        val nl = if ("\r\n" in sdp) "\r\n" else "\n"
        val lines = sdp.split(nl)
        val hint = "x-google-start-bitrate=$START_KBPS;x-google-min-bitrate=$MIN_KBPS;x-google-max-bitrate=$MAX_KBPS"
        val rtpmap = Regex("""^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)/""")
        val fmtp = Regex("""^a=fmtp:(\d+) """)
        val video = lines.mapNotNull { rtpmap.find(it)?.groupValues?.get(1) }.toSet()
        val described = lines.mapNotNull { fmtp.find(it)?.groupValues?.get(1) }.toSet()
        val out = mutableListOf<String>()
        for (line in lines) {
            val pt = fmtp.find(line)?.groupValues?.get(1)
            out += if (pt != null && pt in video && "x-google-start-bitrate" !in line) "$line;$hint" else line
            val mapped = rtpmap.find(line)?.groupValues?.get(1)
            // VP8 usually has no fmtp line of its own: give it one.
            if (mapped != null && mapped !in described) out += "a=fmtp:$mapped $hint"
        }
        return out.joinToString(nl)
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
    private const val TAG = "LANclave/mirror"
    /** Connection counters are logged this often, this many times per share. */
    private const val STATS_EVERY_S = 5L
    private const val STATS_TIMES = 12

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
    private var ticker: ScheduledFuture<*>? = null
    /** Frames the screen capture produced this share, from its own thread. */
    private val captured = AtomicInteger()

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var pc: PeerConnection? = null

    /** A step of sharing, to logcat and to Metro (`onMirrorLog`), to pin down where it goes wrong. */
    private fun log(line: String) {
        Log.i(TAG, line)
        Events.emit("onMirrorLog", mapOf("line" to line))
    }

    private fun candidates(sdp: String?): List<String> =
        sdp.orEmpty().lines().map { it.trim() }.filter { it.startsWith("a=candidate") }

    private fun logCandidates(whose: String, sdp: String?) {
        val found = candidates(sdp)
        log("$whose has ${found.size} candidate(s)")
        found.forEach { log("  $it") }
    }

    private fun statusText(status: Int): String = when (status) {
        PeerHttp.UNREACHABLE -> "unreachable"
        PeerHttp.TIMED_OUT -> "timed out"
        PeerHttp.REFUSED_CERTIFICATE -> "certificate refused"
        else -> "HTTP $status"
    }

    private fun report(next: String, message: String? = null) {
        log("state $next${message?.let { ": $it" } ?: ""}")
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
        if (state != "idle") return log("start ignored: already $state")
        val current = run.incrementAndGet()
        log("start #$current: asking ${peerName ?: peerId} at $peerAddr")
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
            log("capture service did not start: $e")
            worker.execute { finish(current, "failed", "Android did not let screen sharing start.") }
            return
        }
        requests.execute { ask(current, peerAddr) }
    }

    private fun ask(current: Int, addr: String) {
        val began = System.currentTimeMillis()
        val reply = send(addr, "/api/mirror/sessions", "{}", ASK_TIMEOUT_MS)
        val session = if (reply.status == 200) {
            try { JSONObject(reply.body).getString("session_id") } catch (_: Exception) { null }
        } else null
        log("ask #$current: ${statusText(reply.status)} after ${System.currentTimeMillis() - began} ms, body ${reply.body.take(200)}")
        val name = peerName ?: "The laptop"
        worker.execute {
            if (run.get() != current) {
                log("ask #$current: answer ignored, sharing was stopped meanwhile")
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
            if (state == "idle") {
                log("capture service up, but sharing already stopped")
                return@execute MirrorService.stop()
            }
            log("capture service in the foreground")
            serviceUp = true
            maybeConnect(run.get())
        }
    }

    /** From [MirrorService]: Android refused to put it in the foreground. */
    fun serviceFailed(error: Exception? = null) {
        log("capture service refused the foreground: $error")
        worker.execute { finish(run.get(), "failed", "Android did not let screen sharing start.") }
    }

    /** Capture begins once the laptop said yes and the service is in the foreground. */
    private fun maybeConnect(current: Int) {
        if (!serviceUp || !accepted || pc != null || run.get() != current) {
            log("connect #$current waits: service up=$serviceUp, accepted=$accepted, connection=${pc != null}, run=${run.get()}")
            return
        }
        val context = appContext ?: return log("connect #$current: no context")
        val data = consent ?: return finish(current, "failed", "Screen capture was not allowed.")
        try {
            connect(current, context, data)
        } catch (e: Exception) {
            Log.e(TAG, "connect #$current threw", e)
            log("connect #$current threw: $e")
            finish(current, "failed", "Could not start sharing: ${e.message}")
        }
    }

    /** This phone's interfaces and addresses: what WebRTC can offer. */
    private fun logInterfaces() {
        try {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().filter { it.isUp && !it.isLoopback }.forEach { nif ->
                log("interface ${nif.name}: ${nif.inetAddresses.toList().joinToString { it.hostAddress ?: "?" }}")
            }
        } catch (e: Exception) {
            log("interfaces unreadable: $e")
        }
    }

    private fun connect(current: Int, context: Context, data: Intent) {
        log("connect #$current: begin")
        logInterfaces()
        if (factory == null) {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
            egl = EglBase.create()
            val options = PeerConnectionFactory.Options().apply {
                // WebRTC's Android network monitor only offers interfaces
                // ConnectivityManager lists, and binds each socket to one.
                // This phone's own hotspot is not listed, so a laptop on it
                // was offered only mobile-data addresses, and the phone's
                // checks left over mobile data. Without the monitor every
                // interface is offered and the system routes, as it does
                // for the rest of the app's traffic to the laptop.
                disableNetworkMonitor = true
                // The laptop is on the same network: never mobile data.
                networkIgnoreMask = PeerConnectionFactory.Options.ADAPTER_TYPE_CELLULAR
            }
            factory = PeerConnectionFactory.builder()
                .setOptions(options)
                // Hardware encoders where the phone has them: cooler and faster.
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
                .createPeerConnectionFactory()
            log("WebRTC ready")
        }
        val factory = factory!!
        val couldNot = "Could not start sharing."

        val metrics = context.resources.displayMetrics
        val (width, height) = MirrorSize.fit(metrics.widthPixels, metrics.heightPixels)
        log("screen ${metrics.widthPixels}x${metrics.heightPixels}, capturing ${width}x$height at $FPS fps")

        val capturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            // The user revoked it from the system UI, or the screen locked
            // for good. Not when teardown stopped it: that run is over.
            override fun onStop() {
                log("Android stopped the screen capture (run #$current, now #${run.get()})")
                if (run.get() == current) stop("Android stopped the screen capture")
            }
        })
        val helper = SurfaceTextureHelper.create("lanclave-mirror", egl!!.eglBaseContext)
        val source = factory.createVideoSource(true)
        this.capturer = capturer
        this.helper = helper
        this.source = source
        captured.set(0)
        val feed = source.capturerObserver
        // Counts frames on the way through: no frames means capture, not the network.
        capturer.initialize(helper, context, object : CapturerObserver {
            override fun onCapturerStarted(success: Boolean) {
                log("capture started: $success")
                feed.onCapturerStarted(success)
            }
            override fun onCapturerStopped() {
                log("capture stopped after ${captured.get()} frames")
                feed.onCapturerStopped()
            }
            override fun onFrameCaptured(frame: VideoFrame) {
                if (captured.incrementAndGet() == 1) log("first frame captured: ${frame.rotatedWidth}x${frame.rotatedHeight}")
                feed.onFrameCaptured(frame)
            }
        })
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
                log("ICE gathering $state")
                if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown()
            }
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                log("connection $state")
                worker.execute { connectionChanged(current, state) }
            }
            override fun onSignalingChange(state: PeerConnection.SignalingState) { log("signaling $state") }
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { log("ICE connection $state") }
            override fun onIceConnectionReceivingChange(receiving: Boolean) { log("ICE receiving $receiving") }
            override fun onIceCandidate(candidate: IceCandidate) { log("gathered ${candidate.sdp}") }
            override fun onIceCandidateError(event: IceCandidateErrorEvent) {
                log("candidate error ${event.errorCode} ${event.errorText} at ${event.address}:${event.port} ${event.url}")
            }
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) {
                log("using ${event.local.sdp} -> ${event.remote.sdp} (${event.reason})")
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: org.webrtc.DataChannel) {}
            override fun onRenegotiationNeeded() {}
        }) ?: return finish(current, "failed", couldNot).also { log("createPeerConnection returned null") }
        this.pc = pc
        val transceiver = pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("screen")))
        preferHardwareCodecs(transceiver, factory)
        var ticks = 0
        ticker = worker.scheduleAtFixedRate({
            if (run.get() == current && ++ticks <= STATS_TIMES) this.pc?.let { logStats(it, "${ticks * STATS_EVERY_S} s, ${captured.get()} frames captured") }
        }, STATS_EVERY_S, STATS_EVERY_S, TimeUnit.SECONDS)

        val offer = awaitSdp("create offer") { observer -> pc.createOffer(observer, MediaConstraints()) }
            ?: return finish(current, "failed", couldNot)
        awaitSet("set offer") { observer -> pc.setLocalDescription(observer, offer) } ?: return finish(current, "failed", couldNot)
        // On a LAN every address is known within a moment: send them all at once.
        if (!gathered.await(3, TimeUnit.SECONDS)) log("ICE gathering not done after 3 s; sending what there is")
        if (run.get() != current) return log("connect #$current: stopped while gathering")

        val local = pc.localDescription?.description ?: return finish(current, "failed", couldNot)
        logCandidates("offer", local)
        val began = System.currentTimeMillis()
        val reply = send(
            peerAddr ?: return finish(current, "failed", "No laptop to share with."),
            "/api/mirror/sessions/$sessionId/offer", JSONObject().put("sdp", local).toString(), 25_000,
        )
        log("offer sent: ${statusText(reply.status)} after ${System.currentTimeMillis() - began} ms")
        if (run.get() != current) return log("connect #$current: stopped while the laptop answered")
        val answer = try { JSONObject(reply.body).getString("sdp") } catch (_: Exception) { null }
        if (reply.status != 200 || answer == null) {
            log("no usable answer, body ${reply.body.take(200)}")
            return finish(current, "failed", "The laptop did not start showing the screen.")
        }
        logCandidates("answer", answer)
        val tuned = MirrorTuning.withBitrates(answer)
        awaitSet("set answer") { observer -> pc.setRemoteDescription(observer, SessionDescription(SessionDescription.Type.ANSWER, tuned)) }
            ?: return finish(current, "failed", "The laptop's answer could not be used.")
        tune(transceiver.sender)
        log("connect #$current: answer applied, connecting")
    }

    private fun preferHardwareCodecs(transceiver: RtpTransceiver, factory: PeerConnectionFactory) {
        try {
            val hardware = HardwareVideoEncoderFactory(egl!!.eglBaseContext, true, true).supportedCodecs.map { it.name }.toSet()
            val codecs = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
            val ordered = MirrorTuning.hardwareFirst(codecs, { it.name }, hardware)
            transceiver.setCodecPreferences(ordered)
            log("hardware encoders: ${hardware.joinToString().ifEmpty { "none" }}; offering ${ordered.map { it.name }.distinct().joinToString()}")
        } catch (e: Exception) {
            log("codec preference not set: $e")
        }
    }

    /** Sharp text over smoothness, and a bitrate a LAN can carry. */
    private fun tune(sender: RtpSender) {
        val params = sender.parameters
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        params.encodings.forEach {
            it.minBitrateBps = MirrorTuning.MIN_KBPS * 1000
            it.maxBitrateBps = MirrorTuning.MAX_KBPS * 1000
            it.maxFramerate = FPS
        }
        log("sender tuned: ${sender.setParameters(params)}")
    }

    private fun connectionChanged(current: Int, next: PeerConnection.PeerConnectionState) {
        if (run.get() != current) return
        when (next) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                grace?.cancel(false)
                grace = null
                pc?.let { logStats(it, "connected") }
                report("sharing")
            }
            PeerConnection.PeerConnectionState.FAILED -> {
                pc?.let { logStats(it, "failed") }
                finish(current, "failed", "The connection to the laptop was lost.")
            }
            PeerConnection.PeerConnectionState.CLOSED -> finish(current, "ended")
            // Closing the window there looks like this too; a Wi-Fi blip
            // passes within the grace period.
            PeerConnection.PeerConnectionState.DISCONNECTED -> if (grace == null) {
                pc?.let { logStats(it, "disconnected") }
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

    /** What the connection is doing, from WebRTC's own counters. Worker only. */
    private fun logStats(pc: PeerConnection, why: String) {
        val done = CountDownLatch(1)
        var lines = emptyList<String>()
        pc.getStats { report ->
            lines = statsLines(report.statsMap.values)
            done.countDown()
        }
        if (!done.await(1, TimeUnit.SECONDS)) return log("stats ($why): none in time")
        log("stats ($why):")
        if (lines.isEmpty()) log("  nothing yet")
        lines.forEach { log("  $it") }
    }

    private fun statsLines(stats: Collection<RTCStats>): List<String> {
        val byId = stats.associateBy { it.id }
        fun candidate(id: Any?): String = byId[id as? String]?.members?.let {
            "${it["address"] ?: it["ip"]}:${it["port"]} ${it["candidateType"]}/${it["protocol"]}"
        } ?: "?"
        return stats.mapNotNull { s ->
            val m = s.members
            when (s.type) {
                "candidate-pair" -> "pair ${m["state"]}${if (m["nominated"] == true) " nominated" else ""}: " +
                    "${candidate(m["localCandidateId"])} -> ${candidate(m["remoteCandidateId"])}, " +
                    "sent ${m["bytesSent"]} B, received ${m["bytesReceived"]} B, checks ${m["requestsSent"]}/${m["responsesReceived"]}, " +
                    "rtt ${m["currentRoundTripTime"]} s, available ${m["availableOutgoingBitrate"]} bps"
                "outbound-rtp" -> "video out: ${byId[m["codecId"] as? String]?.members?.get("mimeType")}, " +
                    "${m["framesEncoded"]} encoded, ${m["framesSent"]} sent, ${m["framesPerSecond"]} fps, ${m["bytesSent"]} B, " +
                    "target ${m["targetBitrate"]} bps, ${m["frameWidth"]}x${m["frameHeight"]}, " +
                    "encoder ${m["encoderImplementation"]}, limited by ${m["qualityLimitationReason"]}"
                else -> null
            }
        }
    }

    /** Stop sharing, from any thread; tells the laptop. Takes effect at once. */
    fun stop(why: String = "asked to") {
        if (state == "idle") return
        val ended = run.incrementAndGet()
        log("stop #${ended - 1}: $why")
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
            val reply = PeerHttp.request(addr, "POST", "/api/mirror/sessions/$session/stop", "{}", Tls.Trust.PAIRED, true, 5_000)
            log("told the laptop sharing stopped: ${statusText(reply.status)}")
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
        ticker?.cancel(false)
        ticker = null
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

    private fun awaitSdp(step: String, call: (SdpObserver) -> Unit): SessionDescription? {
        val done = CountDownLatch(1)
        var result: SessionDescription? = null
        var failure: String? = null
        call(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) { result = sdp; done.countDown() }
            override fun onCreateFailure(error: String?) { failure = error; done.countDown() }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String?) {}
        })
        if (!done.await(10, TimeUnit.SECONDS)) log("$step: no reply in 10 s")
        else if (result == null) log("$step failed: $failure")
        return result
    }

    private fun awaitSet(step: String, call: (SdpObserver) -> Unit): Unit? {
        val done = CountDownLatch(1)
        var ok = false
        var failure: String? = null
        call(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {}
            override fun onCreateFailure(error: String?) {}
            override fun onSetSuccess() { ok = true; done.countDown() }
            override fun onSetFailure(error: String?) { failure = error; done.countDown() }
        })
        if (!done.await(10, TimeUnit.SECONDS)) log("$step: no reply in 10 s")
        else if (!ok) log("$step failed: $failure")
        return if (ok) Unit else null
    }
}
