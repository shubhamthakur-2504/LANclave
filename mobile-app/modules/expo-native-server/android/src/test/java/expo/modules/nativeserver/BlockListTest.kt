package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class BlockListTest {
    @Test
    fun aBlockSurvivesARestartAndCanBeLifted() {
        val file = File.createTempFile("blocked", ".json").apply { delete() }
        try {
            val list = BlockList(file)
            list.block("pest", "Somebody's laptop")
            list.block("pest", null)
            assertTrue(list.contains("pest"))
            assertFalse(list.contains("friend"))

            val reloaded = BlockList(file)
            assertEquals("blocking twice keeps one entry", 1, reloaded.list().size)
            assertEquals("Somebody's laptop", reloaded.list()[0].deviceName)

            assertTrue(reloaded.unblock("pest"))
            assertFalse(BlockList(file).contains("pest"))
        } finally {
            file.delete()
        }
    }
}
