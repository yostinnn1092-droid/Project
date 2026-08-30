package tw.easywallet.nfc

import android.content.Context
import java.io.File

/**
 * Supplies the MIFARE Classic sector keys used to authenticate against a card.
 *
 * This app deliberately ships **no** EasyCard-specific keys. It ships only the
 * well-known MIFARE *default* keys that are published in NXP's own datasheets and
 * are already built into essentially every NFC library. Anything beyond that has
 * to be provided by the user, as a key file, for a card they own.
 *
 * File format is the same one MIFARE Classic Tool uses, so existing key files
 * drop straight in:
 *
 *     # comments and blank lines are ignored
 *     FFFFFFFFFFFF
 *     A0A1A2A3A4A5
 *
 * Keys are tried in file order, then the defaults.
 */
class KeyStoreFile(private val context: Context) {

    private val file: File
        get() = File(context.filesDir, KEY_FILE_NAME)

    fun hasUserKeys(): Boolean = file.exists() && userKeys().isNotEmpty()

    fun userKeyCount(): Int = userKeys().size

    /** Overwrites the stored key file with [content] (raw text of a .keys file). */
    fun importFrom(content: String) {
        file.writeText(content)
    }

    fun clear() {
        file.delete()
    }

    /** User keys first (most likely to hit), then the public defaults. */
    fun allKeys(): List<ByteArray> = (userKeys() + DEFAULT_KEYS).distinctBy { it.toList() }

    private fun userKeys(): List<ByteArray> {
        if (!file.exists()) return emptyList()
        return runCatching { file.readText() }
            .getOrDefault("")
            .lineSequence()
            .map { it.substringBefore('#').trim() }
            .filter { it.length == 12 && it.all { c -> c.isHexDigit() } }
            .map { it.hexToBytes() }
            .toList()
    }

    companion object {
        const val KEY_FILE_NAME = "sector_keys.txt"

        /** Published MIFARE Classic transport/default keys. Not EasyCard specific. */
        val DEFAULT_KEYS: List<ByteArray> = listOf(
            "FFFFFFFFFFFF",
            "A0A1A2A3A4A5",
            "D3F7D3F7D3F7",
            "000000000000",
            "B0B1B2B3B4B5",
            "4D3A99C351DD",
            "1A982C7E459A",
            "AABBCCDDEEFF"
        ).map { it.hexToBytes() }
    }
}

private fun Char.isHexDigit(): Boolean =
    this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

internal fun String.hexToBytes(): ByteArray =
    ByteArray(length / 2) { i -> ((digit(this[i * 2]) shl 4) or digit(this[i * 2 + 1])).toByte() }

private fun digit(c: Char): Int = Character.digit(c, 16)

internal fun ByteArray.toHex(): String =
    joinToString("") { "%02X".format(it) }
