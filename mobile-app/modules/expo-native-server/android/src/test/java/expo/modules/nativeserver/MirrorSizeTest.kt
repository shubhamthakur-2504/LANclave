package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Test

class MirrorSizeTest {
    @Test
    fun aTallScreenIsCappedOnItsLongSideAndKeepsItsShape() {
        assertEquals(864 to 1920, MirrorSize.fit(1080, 2400))
    }

    @Test
    fun aSmallScreenIsLeftAloneButMadeEven() {
        assertEquals(720 to 1600, MirrorSize.fit(720, 1600))
        assertEquals(720 to 1280, MirrorSize.fit(721, 1281))
    }
}
