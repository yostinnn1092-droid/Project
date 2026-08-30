package tw.easywallet.data

import kotlinx.coroutines.flow.Flow
import tw.easywallet.model.CardSnapshot
import tw.easywallet.ui.theme.CardPalette

class WalletRepository(private val dao: WalletDao) {

    fun observeCards(): Flow<List<CardEntity>> = dao.observeCards()
    fun observeCard(uid: String): Flow<CardEntity?> = dao.observeCard(uid)
    fun observeSamples(uid: String): Flow<List<BalanceSampleEntity>> = dao.observeSamples(uid)
    fun observeTxns(uid: String): Flow<List<TxnEntity>> = dao.observeTxns(uid)

    suspend fun rename(uid: String, nickname: String) = dao.renameCard(uid, nickname)
    suspend fun delete(uid: String) = dao.deleteCard(uid)

    /**
     * Folds a fresh tap into the wallet.
     *
     * Keeps whatever the user already personalised (nickname, colour) and only
     * moves the balance forward; a card that came back unreadable must not wipe
     * the last good balance we had for it.
     */
    suspend fun saveScan(snapshot: CardSnapshot): CardEntity {
        val existing = dao.findCard(snapshot.uid)
        val now = snapshot.readAtEpochMillis

        val card = CardEntity(
            uid = snapshot.uid,
            nickname = existing?.nickname ?: defaultNickname(snapshot.uid),
            colorArgb = existing?.colorArgb ?: CardPalette.forUid(snapshot.uid),
            lastBalanceNtd = snapshot.balanceNtd ?: existing?.lastBalanceNtd,
            lastReadEpochMillis = now,
            addedEpochMillis = existing?.addedEpochMillis ?: now
        )

        // Only sample when the balance actually moved. Tapping the same card five
        // times in a row should be five reads and one point on the chart.
        val sample = snapshot.balanceNtd
            ?.takeIf { it != dao.latestSample(snapshot.uid)?.balanceNtd }
            ?.let { BalanceSampleEntity(cardUid = snapshot.uid, balanceNtd = it, readEpochMillis = now) }

        val txns = snapshot.transactions.map {
            TxnEntity(
                cardUid = snapshot.uid,
                epochSeconds = it.epochSeconds,
                rawHex = it.rawHex,
                amountNtd = it.amountNtd,
                balanceAfterNtd = it.balanceAfterNtd,
                kind = it.kind.name
            )
        }

        dao.recordScan(card, sample, txns)
        return card
    }

    private fun defaultNickname(uid: String) = "EasyCard ${uid.takeLast(4)}"
}
