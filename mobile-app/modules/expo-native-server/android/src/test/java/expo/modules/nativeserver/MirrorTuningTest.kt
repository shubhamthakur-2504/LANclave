package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MirrorTuningTest {
    private val offered = listOf("VP8", "rtx", "VP9", "H264", "H264", "AV1", "red", "ulpfec")

    @Test
    fun hardwareCodecsComeFirstWithH264Ahead() {
        val ordered = MirrorTuning.hardwareFirst(offered, { it }, setOf("VP8", "H264"))
        assertEquals(listOf("H264", "H264", "VP8", "rtx", "VP9", "AV1", "red", "ulpfec"), ordered)
    }

    @Test
    fun withoutHardwareEncodersTheOrderStays() {
        assertEquals(offered, MirrorTuning.hardwareFirst(offered, { it }, emptySet()))
    }

    private val answer = listOf(
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 96 97 102",
        "a=rtpmap:96 VP8/90000",
        "a=rtpmap:97 rtx/90000",
        "a=fmtp:97 apt=96",
        "a=rtpmap:102 H264/90000",
        "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        "",
    ).joinToString("\r\n")

    @Test
    fun everyVideoCodecGetsBitrateHintsAndRetransmissionIsLeftAlone() {
        val lines = MirrorTuning.withBitrates(answer).split("\r\n")
        val hint = "x-google-start-bitrate=${MirrorTuning.START_KBPS};" +
            "x-google-min-bitrate=${MirrorTuning.MIN_KBPS};x-google-max-bitrate=${MirrorTuning.MAX_KBPS}"
        assertEquals("a=rtpmap:96 VP8/90000", lines[2])
        assertEquals("a=fmtp:96 $hint", lines[3])
        assertEquals("a=fmtp:97 apt=96", lines[5])
        assertEquals("a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;$hint", lines[7])
        assertTrue(MirrorTuning.withBitrates(answer).endsWith("\r\n"))
    }

    @Test
    fun hintsAreNotAddedTwice() {
        val once = MirrorTuning.withBitrates(answer)
        assertEquals(once, MirrorTuning.withBitrates(once))
    }
}
