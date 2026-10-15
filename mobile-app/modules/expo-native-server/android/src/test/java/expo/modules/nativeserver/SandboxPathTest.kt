package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Must agree with `validate_sandboxed_path` in desktop-app/src-tauri/src/sandbox.rs. */
class SandboxPathTest {
    @Test
    fun nestedPathsAreSplitIntoSegments() {
        assertEquals(listOf("photos", "2026", "a.jpg"), SandboxPath.segments("photos/2026/a.jpg"))
        assertEquals(listOf("notes.txt"), SandboxPath.segments("notes.txt"))
    }

    @Test
    fun pathsThatCouldLeaveTheSandboxAreRefused() {
        for (bad in listOf("", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a/", "a\\b", "C:/x", "a\u0000b")) {
            assertNull(bad, SandboxPath.segments(bad))
        }
    }

    @Test
    fun aResolvedPathStaysUnderTheRoot() {
        val root = Files.createTempDirectory("sandbox").toFile()
        try {
            File(root, "photos").mkdirs()
            assertNotNull(SandboxPath.resolve(root, listOf("photos")))
            // Segments are validated first; this checks the second line of defence.
            assertNull(SandboxPath.resolve(root, listOf("..", "outside")))
        } finally {
            root.deleteRecursively()
        }
    }
}
