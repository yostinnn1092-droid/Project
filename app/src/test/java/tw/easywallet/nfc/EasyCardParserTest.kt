package tw.easywallet.nfc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tw.easywallet.model.TxnKind

class EasyCardParserTest {

    private val now = 1_756_000_000L // 2025-08-24, a fixed "now" so tests don't rot

    // -- balance ----------------------------------------------------------------

    @Test
    fun `reads balance as little-endian int32`() {
        val sectors = mapOf(2 to listOf(block("F4010000" + "00".repeat(12))))
        assertEquals(500, EasyCardParser.parseBalance(sectors))
    }

    @Test
    fun `zero balance is a real balance, not a missing one`() {
        val sectors = mapOf(2 to listOf(block("00".repeat(16))))
        assertEquals(0, EasyCardParser.parseBalance(sectors))
    }

    @Test
    fun `rejects a balance above the stored-value ceiling`() {
        // 0x00FFFFFF = 16.7M NT dollars: the offsets are wrong, not the user rich.
        val sectors = mapOf(2 to listOf(block("FFFFFF00" + "00".repeat(12))))
        assertNull(EasyCardParser.parseBalance(sectors))
    }

    @Test
    fun `missing balance sector yields null rather than zero`() {
        assertNull(EasyCardParser.parseBalance(emptyMap()))
    }

    @Test
    fun `truncated balance block does not crash`() {
        val sectors = mapOf(2 to listOf(block("F401")))
        assertNull(EasyCardParser.parseBalance(sectors))
    }

    // -- transactions -----------------------------------------------------------

    @Test
    fun `decodes a fare record`() {
        val record = txnBytes(type = 0x01, epoch = now - 3600, amount = 20, balanceAfter = 480)
        val txns = EasyCardParser.parseTransactions(mapOf(3 to listOf(record)), nowEpochSeconds = now)

        assertEquals(1, txns.size)
        assertEquals(now - 3600, txns[0].epochSeconds)
        assertEquals(TxnKind.FARE, txns[0].kind)
        assertEquals(-20, txns[0].amountNtd) // fares are normalised to negative
        assertEquals(480, txns[0].balanceAfterNtd)
    }

    @Test
    fun `decodes a top-up record`() {
        val record = txnBytes(type = 0x00, epoch = now - 60, amount = 500, balanceAfter = 980)
        val txns = EasyCardParser.parseTransactions(mapOf(3 to listOf(record)), nowEpochSeconds = now)

        assertEquals(1, txns.size)
        assertEquals(TxnKind.TOP_UP, txns[0].kind)
        assertEquals(500, txns[0].amountNtd)
    }

    @Test
    fun `drops records whose timestamp predates smart ticketing`() {
        val record = txnBytes(type = 0x01, epoch = 0, amount = 20, balanceAfter = 480)
        assertTrue(EasyCardParser.parseTransactions(mapOf(3 to listOf(record)), nowEpochSeconds = now).isEmpty())
    }

    @Test
    fun `drops records dated in the future`() {
        val record = txnBytes(type = 0x01, epoch = now + 86_400 * 30, amount = 20, balanceAfter = 480)
        assertTrue(EasyCardParser.parseTransactions(mapOf(3 to listOf(record)), nowEpochSeconds = now).isEmpty())
    }

    @Test
    fun `drops records with an impossible balance`() {
        val record = txnBytes(type = 0x01, epoch = now - 100, amount = 20, balanceAfter = 900_000)
        assertTrue(EasyCardParser.parseTransactions(mapOf(3 to listOf(record)), nowEpochSeconds = now).isEmpty())
    }

    @Test
    fun `skips the sector key trailer`() {
        // Block 3 holds keys and access bits. If it were parsed as a record it would
        // pass no sanity check anyway, but it must never even be considered.
        val trailer = block("A0A1A2A3A4A5" + "FF078069" + "FFFFFFFFFFFF".take(8))
        val sectors = mapOf(3 to listOf(zeroBlock(), zeroBlock(), zeroBlock(), trailer))
        assertTrue(EasyCardParser.parseTransactions(sectors, nowEpochSeconds = now).isEmpty())
    }

    @Test
    fun `skips all-zero blocks`() {
        val sectors = mapOf(3 to listOf(zeroBlock(), zeroBlock()))
        assertTrue(EasyCardParser.parseTransactions(sectors, nowEpochSeconds = now).isEmpty())
    }

    @Test
    fun `returns newest transactions first across sectors`() {
        val older = txnBytes(type = 0x01, epoch = now - 7200, amount = 20, balanceAfter = 500)
        val newer = txnBytes(type = 0x01, epoch = now - 600, amount = 15, balanceAfter = 485)
        val sectors = mapOf(3 to listOf(older), 4 to listOf(newer))

        val txns = EasyCardParser.parseTransactions(sectors, nowEpochSeconds = now)

        assertEquals(2, txns.size)
        assertEquals(now - 600, txns[0].epochSeconds)
        assertEquals(now - 7200, txns[1].epochSeconds)
    }

    @Test
    fun `keeps the raw bytes so a mis-decode stays auditable`() {
        val record = txnBytes(type = 0x01, epoch = now - 100, amount = 20, balanceAfter = 480)
        val txns = EasyCardParser.parseTransactions(mapOf(3 to listOf(record)), nowEpochSeconds = now)
        assertEquals(32, txns[0].rawHex.length)
    }

    // -- helpers ----------------------------------------------------------------

    private fun block(hex: String) = hex.hexToBytes()

    private fun zeroBlock() = ByteArray(16)

    /** Builds a 16-byte record matching [EasyCardParser.Layout.DEFAULT]. */
    private fun txnBytes(type: Int, epoch: Long, amount: Int, balanceAfter: Int): ByteArray {
        val b = ByteArray(16)
        val l = EasyCardParser.Layout.DEFAULT
        b[l.txnTypeOffset] = type.toByte()
        putIntLe(b, l.txnTimestampOffset, epoch.toInt())
        putShortLe(b, l.txnAmountOffset, amount)
        putIntLe(b, l.txnBalanceAfterOffset, balanceAfter)
        return b
    }

    private fun putIntLe(b: ByteArray, offset: Int, value: Int) {
        for (i in 0 until 4) b[offset + i] = ((value shr (8 * i)) and 0xFF).toByte()
    }

    private fun putShortLe(b: ByteArray, offset: Int, value: Int) {
        for (i in 0 until 2) b[offset + i] = ((value shr (8 * i)) and 0xFF).toByte()
    }
}
