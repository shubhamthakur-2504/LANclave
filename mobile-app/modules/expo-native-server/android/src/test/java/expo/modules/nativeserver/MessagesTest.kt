package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/** The same rules as the tests in `messages.rs`. */
class MessagesTest {
    @Before
    fun fresh() = Messages.useFile(null)

    @Test
    fun aRetriedMessageIsStoredOnce() {
        assertTrue(Messages.receive("laptop", "m1", "482 913", 10))
        assertFalse(Messages.receive("laptop", "m1", "482 913", 10))
        assertEquals(1, Messages.thread("laptop").size)
        assertEquals(1, Messages.summaries()[0]["unread"])
    }

    @Test
    fun aMessageWaitsUntilTheOtherDeviceHasIt() {
        val sent = Messages.queueOutgoing("laptop", "https://example.com")
        assertEquals(1, Messages.waitingFor("laptop").size)
        Messages.markDelivered("laptop", listOf(sent.id))
        assertTrue(Messages.waitingFor("laptop").isEmpty())
        assertEquals(Messages.DELIVERED, Messages.thread("laptop")[0].state)
    }

    @Test
    fun blankAndOversizedTextIsRefused() {
        assertThrows(IllegalArgumentException::class.java) { Messages.queueOutgoing("laptop", "  \n ") }
        assertThrows(IllegalArgumentException::class.java) {
            Messages.queueOutgoing("laptop", "x".repeat(Messages.MAX_TEXT_BYTES + 1))
        }
        assertEquals(413, Messages.handleReceive("laptop", """{"id":"a","text":"${"x".repeat(Messages.MAX_TEXT_BYTES + 1)}","sent_at":1}""").first)
        assertTrue(Messages.thread("laptop").isEmpty())
    }

    @Test
    fun theCallerFetchesWhatWaitsAndAcknowledgesIt() {
        val sent = Messages.queueOutgoing("laptop", "see you at 5")
        assertTrue(Messages.pendingJson("laptop").contains("see you at 5"))
        Messages.handleAck("laptop", """{"ids":["${sent.id}"]}""")
        assertEquals("[]", Messages.pendingJson("laptop"))
    }

    @Test
    fun threadsSurviveARestart() {
        val file = File.createTempFile("messages", ".json").apply { delete() }
        try {
            Messages.useFile(file)
            Messages.receive("laptop", "a", "kept", 1)
            Messages.useFile(file)
            assertEquals("kept", Messages.thread("laptop")[0].text)
            Messages.forget("laptop")
            Messages.useFile(file)
            assertTrue(Messages.thread("laptop").isEmpty())
        } finally {
            file.delete()
            File(file.path + ".tmp").delete()
        }
    }
}
