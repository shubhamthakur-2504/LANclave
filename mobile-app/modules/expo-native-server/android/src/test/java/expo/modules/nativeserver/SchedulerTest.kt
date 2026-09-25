package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SchedulerTest {
    private fun queue(vararg keys: String) = Scheduler<String>().apply { keys.forEach { add(it) } }

    @Test
    fun atMostMaxRunAndTheRestWaitInOrder() {
        val q = queue("a", "b", "c", "d")
        assertEquals(listOf("a", "b"), q.take(0))
        assertTrue("no free slot", q.take(0).isEmpty())
        assertEquals(0, q.ahead("c"))
        assertEquals(1, q.ahead("d"))
        assertNull("running downloads have no place in line", q.ahead("a"))
    }

    @Test
    fun aPauseFreesTheSlotForTheNextWaitingDownload() {
        val q = queue("a", "b", "c")
        q.take(0)
        q.finished("a") // paused
        assertEquals(listOf("c"), q.take(0))
    }

    @Test
    fun aResumeGoesToTheFrontWithoutInterruptingAnyone() {
        val q = queue("a", "b", "c", "d")
        q.take(0) // a, b run
        q.finished("a")
        q.add("a", front = true)
        assertEquals(listOf("a"), q.take(0))
        assertTrue("b kept running", q.isRunning("b"))
        assertEquals(0, q.ahead("c"))
    }

    @Test
    fun aSenderPauseWaitsItsTurnAgain() {
        val q = queue("a", "b").apply { max = 1 }
        assertEquals(listOf("a"), q.take(1_000))
        q.later("a", 6_000)
        q.finished("a")
        assertEquals(listOf("b"), q.take(1_000))
        q.finished("b")
        assertTrue(q.take(5_999).isEmpty())
        assertEquals(listOf("a"), q.take(6_000))
    }

    @Test
    fun aDownloadStillWindingDownIsNotStartedTwice() {
        val q = queue("a").apply { max = 2 }
        q.take(0)
        // Resumed before its last run released the slot.
        q.add("a", front = true)
        assertTrue(q.take(0).isEmpty())
        q.finished("a")
        assertEquals(listOf("a"), q.take(0))
    }

    @Test
    fun aDownloadThatLeftTheLineIsNotStarted() {
        val q = queue("a", "b")
        q.remove("a")
        assertEquals(listOf("b"), q.take(0))
    }
}
