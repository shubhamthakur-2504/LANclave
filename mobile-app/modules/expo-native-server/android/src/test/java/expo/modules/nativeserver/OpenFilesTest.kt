package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenFilesTest {
    @Test
    fun installersAndProgramsAreRisky() {
        for (n in listOf("app.apk", "GAME.APKS", "setup.exe", "run.sh")) assertTrue(n, OpenFiles.isRisky(n))
        for (n in listOf("photo.jpg", "doc.pdf", "song.mp3", "noext", ".hidden")) assertFalse(n, OpenFiles.isRisky(n))
    }

    @Test
    fun extensionsAreLowercasedAndOptional() {
        assertEquals("jpg", OpenFiles.extensionOf("IMG_1.JPG"))
        assertEquals("gz", OpenFiles.extensionOf("a.tar.gz"))
        assertEquals("", OpenFiles.extensionOf("README"))
    }
}
