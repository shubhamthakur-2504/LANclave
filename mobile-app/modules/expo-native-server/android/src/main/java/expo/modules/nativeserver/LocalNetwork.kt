package expo.modules.nativeserver

import android.content.Context
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * The phone's side of being found on the LAN.
 */
internal object LocalNetwork {
    private var multicastLock: WifiManager.MulticastLock? = null

    /**
     * Keep incoming multicast flowing while the server is visible.
     *
     * Android's Wi-Fi driver drops multicast unless some app holds this lock.
     * Without it the phone never heard a desktop's mDNS query, so it only
     * showed up at the moment it published (or re-published, e.g. after a
     * visibility toggle) and sent its one unsolicited announcement.
     */
    @Synchronized
    fun holdMulticast(context: Context) {
        if (multicastLock?.isHeld == true) return
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            ?: return
        multicastLock = wifi.createMulticastLock("lanclave-mdns").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    @Synchronized
    fun releaseMulticast() {
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
    }

    /** Mobile data and VPN interfaces: never a LAN worth sweeping. */
    private val NOT_LAN = listOf("rmnet", "ccmni", "pdp", "v4-", "clat", "tun", "dummy")

    /**
     * This phone's private IPv4 addresses on Wi-Fi, hotspot, USB or Ethernet.
     *
     * `expo-network` only reports the Wi-Fi *client* address, which is
     * 0.0.0.0 while the phone is the hotspot -- so the scan swept nothing and
     * finished instantly.
     */
    fun ipv4Addresses(): List<String> = try {
        NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            .filter { it.isUp && !it.isLoopback && NOT_LAN.none { p -> it.name.startsWith(p) } }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .filter { it.isSiteLocalAddress }
            .mapNotNull { it.hostAddress }
            .distinct()
    } catch (_: Exception) {
        emptyList()
    }
}
