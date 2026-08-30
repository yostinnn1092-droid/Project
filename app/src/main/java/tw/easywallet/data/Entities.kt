package tw.easywallet.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A card the user has added to the wallet. Keyed by tag UID, so re-tapping the
 * same physical card updates it in place instead of creating a duplicate.
 */
@Entity(tableName = "cards")
data class CardEntity(
    @PrimaryKey val uid: String,
    val nickname: String,
    /** ARGB colour for the card face in the wallet. */
    val colorArgb: Int,
    val lastBalanceNtd: Int?,
    val lastReadEpochMillis: Long,
    val addedEpochMillis: Long
)

/**
 * One balance observation. Cards are only readable when tapped, so "history" here
 * is a series of snapshots, not a live feed — the chart is honest about that.
 */
@Entity(
    tableName = "balance_samples",
    foreignKeys = [
        ForeignKey(
            entity = CardEntity::class,
            parentColumns = ["uid"],
            childColumns = ["cardUid"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("cardUid")]
)
data class BalanceSampleEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val cardUid: String,
    val balanceNtd: Int,
    val readEpochMillis: Long
)

/**
 * A transaction decoded off the card.
 *
 * [rawHex] is part of the primary-key hash on purpose: the card holds a small
 * ring buffer of records, so the same record is re-read on every tap and must
 * de-duplicate rather than pile up.
 */
@Entity(
    tableName = "transactions",
    primaryKeys = ["cardUid", "epochSeconds", "rawHex"],
    foreignKeys = [
        ForeignKey(
            entity = CardEntity::class,
            parentColumns = ["uid"],
            childColumns = ["cardUid"],
            onDelete = ForeignKey.CASCADE
        )
    ]
)
data class TxnEntity(
    val cardUid: String,
    val epochSeconds: Long,
    val rawHex: String,
    val amountNtd: Int,
    val balanceAfterNtd: Int,
    val kind: String
)
