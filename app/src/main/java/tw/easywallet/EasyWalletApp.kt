package tw.easywallet

import android.app.Application
import tw.easywallet.data.WalletDatabase
import tw.easywallet.data.WalletRepository
import tw.easywallet.nfc.EasyCardReader
import tw.easywallet.nfc.KeyStoreFile

/**
 * Hand-rolled container. The graph is three objects deep — a DI framework would
 * be more ceremony than wiring.
 */
class EasyWalletApp : Application() {

    val keyStore: KeyStoreFile by lazy { KeyStoreFile(this) }
    val reader: EasyCardReader by lazy { EasyCardReader(keyStore) }
    val repository: WalletRepository by lazy { WalletRepository(WalletDatabase.get(this).walletDao()) }
}
