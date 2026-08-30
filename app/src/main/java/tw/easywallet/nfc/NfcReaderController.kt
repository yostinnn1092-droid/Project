package tw.easywallet.nfc

import android.app.Activity
import android.nfc.NfcAdapter
import android.os.Bundle

/**
 * Wraps NFC reader mode.
 *
 * Reader mode (rather than the foreground dispatch system) is the right call here:
 * it suppresses the platform's own "new tag collected" sound and Android Beam-era
 * NDEF handling, so a tap lands straight in our reader with no OS chrome — which is
 * what makes the tap feel like a wallet rather than like a debug tool.
 */
class NfcReaderController(private val activity: Activity) {

    private val adapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)

    val isNfcSupported: Boolean get() = adapter != null
    val isNfcEnabled: Boolean get() = adapter?.isEnabled == true

    fun enable(onTag: (android.nfc.Tag) -> Unit) {
        val flags = NfcAdapter.FLAG_READER_NFC_A or
            NfcAdapter.FLAG_READER_NFC_B or
            NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK

        val extras = Bundle().apply {
            // Give the stack longer to notice the tag went away, so a slightly
            // shaky hand doesn't abort a multi-sector read.
            putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_DELAY_MS)
        }

        adapter?.enableReaderMode(activity, { tag -> onTag(tag) }, flags, extras)
    }

    fun disable() {
        adapter?.disableReaderMode(activity)
    }

    private companion object {
        const val PRESENCE_CHECK_DELAY_MS = 250
    }
}
