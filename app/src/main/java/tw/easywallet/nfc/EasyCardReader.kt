package tw.easywallet.nfc

import android.nfc.Tag
import android.nfc.TagLostException
import android.nfc.tech.MifareClassic
import android.util.Log
import tw.easywallet.model.CardKind
import tw.easywallet.model.CardSnapshot
import tw.easywallet.model.ReadFailure
import java.io.IOException

/**
 * Reads an EasyCard over NFC.
 *
 * This is read-only by construction: it authenticates, reads, and disconnects.
 * There is no write path anywhere in this class, and there should never be one —
 * writing to a stored-value transit card is fare fraud.
 */
class EasyCardReader(private val keys: KeyStoreFile) {

    sealed interface Result {
        data class Success(val snapshot: CardSnapshot) : Result
        data class Failure(val reason: ReadFailure) : Result
    }

    fun read(tag: Tag): Result {
        val mifare = MifareClassic.get(tag)
            ?: return Result.Failure(ReadFailure.UnsupportedTechnology)

        val candidateKeys = keys.allKeys()
        val sectors = mutableMapOf<Int, List<ByteArray>>()
        val locked = mutableListOf<Int>()

        return try {
            mifare.connect()
            mifare.timeout = TIMEOUT_MS

            for (sector in 0 until mifare.sectorCount) {
                val blocks = readSector(mifare, sector, candidateKeys)
                if (blocks == null) locked += sector else sectors[sector] = blocks
            }

            val balance = EasyCardParser.parseBalance(sectors)
            if (balance == null && EasyCardParser.Layout.DEFAULT.balanceSector in locked) {
                return Result.Failure(ReadFailure.NoKeyForBalanceSector)
            }

            Result.Success(
                CardSnapshot(
                    uid = tag.id.toHex(),
                    kind = CardKind.MIFARE_CLASSIC,
                    balanceNtd = balance,
                    transactions = EasyCardParser.parseTransactions(sectors),
                    sectors = sectors,
                    readAtEpochMillis = System.currentTimeMillis(),
                    lockedSectors = locked
                )
            )
        } catch (e: TagLostException) {
            Result.Failure(ReadFailure.TagLost)
        } catch (e: IOException) {
            Result.Failure(ReadFailure.Io(e.message ?: "I/O error"))
        } finally {
            runCatching { mifare.close() }
        }
    }

    /**
     * Tries every known key against one sector, key A then key B.
     *
     * Returns null when nothing authenticated — that sector stays locked and is
     * reported to the user rather than silently skipped.
     */
    private fun readSector(
        mifare: MifareClassic,
        sector: Int,
        candidateKeys: List<ByteArray>
    ): List<ByteArray>? {
        for (key in candidateKeys) {
            val authed = try {
                mifare.authenticateSectorWithKeyA(sector, key) ||
                    mifare.authenticateSectorWithKeyB(sector, key)
            } catch (e: IOException) {
                // A failed auth can drop the tag into a state needing a reselect.
                // Bail on this sector rather than poisoning the rest of the read.
                Log.d(TAG, "auth error on sector $sector", e)
                false
            }
            if (!authed) continue

            val first = mifare.sectorToBlock(sector)
            val count = mifare.getBlockCountInSector(sector)
            return try {
                (0 until count).map { mifare.readBlock(first + it) }
            } catch (e: IOException) {
                Log.d(TAG, "read error on sector $sector", e)
                null
            }
        }
        return null
    }

    private companion object {
        const val TAG = "EasyCardReader"

        /** MIFARE auth over a wobbly hand-held tap needs more than the 618ms default. */
        const val TIMEOUT_MS = 2_000
    }
}
