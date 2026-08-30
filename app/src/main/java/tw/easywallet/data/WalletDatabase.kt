package tw.easywallet.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [CardEntity::class, BalanceSampleEntity::class, TxnEntity::class],
    version = 1,
    exportSchema = true
)
abstract class WalletDatabase : RoomDatabase() {

    abstract fun walletDao(): WalletDao

    companion object {
        @Volatile
        private var instance: WalletDatabase? = null

        fun get(context: Context): WalletDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    WalletDatabase::class.java,
                    "easywallet.db"
                ).build().also { instance = it }
            }
    }
}
