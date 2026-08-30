package tw.easywallet.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface WalletDao {

    @Query("SELECT * FROM cards ORDER BY addedEpochMillis ASC")
    fun observeCards(): Flow<List<CardEntity>>

    @Query("SELECT * FROM cards WHERE uid = :uid")
    fun observeCard(uid: String): Flow<CardEntity?>

    @Query("SELECT * FROM cards WHERE uid = :uid")
    suspend fun findCard(uid: String): CardEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCard(card: CardEntity)

    @Query("UPDATE cards SET nickname = :nickname WHERE uid = :uid")
    suspend fun renameCard(uid: String, nickname: String)

    @Query("DELETE FROM cards WHERE uid = :uid")
    suspend fun deleteCard(uid: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertSample(sample: BalanceSampleEntity)

    @Query("SELECT * FROM balance_samples WHERE cardUid = :uid ORDER BY readEpochMillis ASC")
    fun observeSamples(uid: String): Flow<List<BalanceSampleEntity>>

    @Query(
        "SELECT * FROM balance_samples WHERE cardUid = :uid " +
            "ORDER BY readEpochMillis DESC LIMIT 1"
    )
    suspend fun latestSample(uid: String): BalanceSampleEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertTxns(txns: List<TxnEntity>)

    @Query("SELECT * FROM transactions WHERE cardUid = :uid ORDER BY epochSeconds DESC")
    fun observeTxns(uid: String): Flow<List<TxnEntity>>

    /**
     * One tap writes the card, its balance sample, and its transactions atomically,
     * so a crash mid-write can't leave a card showing a balance with no history.
     */
    @Transaction
    suspend fun recordScan(card: CardEntity, sample: BalanceSampleEntity?, txns: List<TxnEntity>) {
        upsertCard(card)
        sample?.let { insertSample(it) }
        if (txns.isNotEmpty()) insertTxns(txns)
    }
}
