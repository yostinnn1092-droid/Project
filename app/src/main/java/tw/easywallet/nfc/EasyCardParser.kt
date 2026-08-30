package tw.easywallet.nfc

import tw.easywallet.model.EasyCardTxn
import tw.easywallet.model.TxnKind

/**
 * Decodes the value fields out of an EasyCard's MIFARE Classic sectors.
 *
 * ## Why this file is written defensively
 *
 * EasyCard's on-card format is not published by EasyCard Corp. The layout below
 * is the community-reverse-engineered one (the same one Metrodroid uses), and it
 * has drifted between card generations. So instead of trusting the offsets and
 * rendering whatever falls out, every decoded record goes through [isPlausible].
 * A record whose timestamp lands in 1974 or whose balance is NT$8,000,000 is
 * dropped rather than shown.
 *
 * The practical effect: if the offsets are wrong for your card, you get an
 * honest "couldn't decode history" plus the raw hex dump — not a screen full of
 * confident nonsense. If you work the real offsets out from the dump, they are
 * all in [Layout] and nowhere else.
 */
object EasyCardParser {

    /**
     * Every card-format assumption in one place, so re-tuning is a one-struct edit.
     */
    data class Layout(
        val balanceSector: Int = 2,
        val balanceBlock: Int = 0,
        val balanceOffset: Int = 0,

        /** Sectors swept for 16-byte transaction records. */
        val recordSectors: List<Int> = listOf(3, 4, 5),

        val txnTypeOffset: Int = 0,
        val txnTimestampOffset: Int = 1,
        val txnAmountOffset: Int = 6,
        val txnBalanceAfterOffset: Int = 8
    ) {
        companion object {
            val DEFAULT = Layout()
        }
    }

    /** Sanity window for a decoded transaction. Tuned to be permissive but not useless. */
    private const val MIN_EPOCH = 1_262_304_000L // 2010-01-01, before EasyCard smart ticketing
    private const val MAX_BALANCE_NTD = 20_000   // EasyCard's own stored-value ceiling is NT$10,000
    private const val MAX_AMOUNT_NTD = 10_000

    /**
     * @param sectors sector index -> its blocks, 16 bytes each, in block order.
     * @return balance in NT dollars, or null if the balance sector was not readable
     *         or the value was not plausible.
     */
    fun parseBalance(sectors: Map<Int, List<ByteArray>>, layout: Layout = Layout.DEFAULT): Int? {
        val block = sectors[layout.balanceSector]?.getOrNull(layout.balanceBlock) ?: return null
        if (block.size < layout.balanceOffset + 4) return null
        val raw = readIntLe(block, layout.balanceOffset)
        return if (raw in 0..MAX_BALANCE_NTD) raw else null
    }

    /**
     * Sweeps [Layout.recordSectors] for transaction records, newest first.
     *
     * Data blocks only — block 3 of each sector is the trailer (keys + access bits)
     * and never holds a record.
     */
    fun parseTransactions(
        sectors: Map<Int, List<ByteArray>>,
        layout: Layout = Layout.DEFAULT,
        nowEpochSeconds: Long = System.currentTimeMillis() / 1000
    ): List<EasyCardTxn> {
        val out = mutableListOf<EasyCardTxn>()

        for (sector in layout.recordSectors) {
            val blocks = sectors[sector] ?: continue
            blocks.forEachIndexed { index, block ->
                if (isTrailerBlock(index)) return@forEachIndexed
                if (block.size < 16) return@forEachIndexed
                if (block.all { it == 0.toByte() }) return@forEachIndexed

                decode(block, layout)
                    ?.takeIf { isPlausible(it, nowEpochSeconds) }
                    ?.let(out::add)
            }
        }

        return out.sortedByDescending { it.epochSeconds }
    }

    /** In a 4-block MIFARE Classic sector, the last block is the key trailer. */
    private fun isTrailerBlock(indexInSector: Int): Boolean = indexInSector % 4 == 3

    private fun decode(block: ByteArray, layout: Layout): EasyCardTxn? {
        if (block.size < layout.txnBalanceAfterOffset + 4) return null

        val epoch = readIntLe(block, layout.txnTimestampOffset).toLong() and 0xFFFF_FFFFL
        val amount = readShortLe(block, layout.txnAmountOffset)
        val balanceAfter = readIntLe(block, layout.txnBalanceAfterOffset)
        val kind = classify(block[layout.txnTypeOffset].toInt() and 0xFF, amount)

        return EasyCardTxn(
            epochSeconds = epoch,
            amountNtd = if (kind == TxnKind.FARE) -kotlin.math.abs(amount) else amount,
            balanceAfterNtd = balanceAfter,
            kind = kind,
            rawHex = block.toHex()
        )
    }

    private fun classify(typeByte: Int, amount: Int): TxnKind = when {
        amount > 0 && typeByte == 0x00 -> TxnKind.TOP_UP
        typeByte in 0x01..0x0F -> TxnKind.FARE
        else -> TxnKind.UNKNOWN
    }

    /**
     * The guard that keeps mis-decoded bytes off the screen. A record must land in
     * a believable time window and carry believable money for us to show it.
     */
    private fun isPlausible(txn: EasyCardTxn, nowEpochSeconds: Long): Boolean {
        val futureSlack = 86_400L * 2 // tolerate a card clock that runs ahead
        if (txn.epochSeconds !in MIN_EPOCH..(nowEpochSeconds + futureSlack)) return false
        if (txn.balanceAfterNtd !in 0..MAX_BALANCE_NTD) return false
        if (kotlin.math.abs(txn.amountNtd) > MAX_AMOUNT_NTD) return false
        return true
    }

    private fun readIntLe(b: ByteArray, offset: Int): Int =
        (b[offset].toInt() and 0xFF) or
            ((b[offset + 1].toInt() and 0xFF) shl 8) or
            ((b[offset + 2].toInt() and 0xFF) shl 16) or
            ((b[offset + 3].toInt() and 0xFF) shl 24)

    private fun readShortLe(b: ByteArray, offset: Int): Int {
        val v = (b[offset].toInt() and 0xFF) or ((b[offset + 1].toInt() and 0xFF) shl 8)
        return v.toShort().toInt() // sign extend
    }
}
