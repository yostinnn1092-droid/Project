package tw.easywallet.ui

import android.nfc.Tag
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tw.easywallet.data.CardEntity
import tw.easywallet.data.WalletRepository
import tw.easywallet.model.CardSnapshot
import tw.easywallet.model.ReadFailure
import tw.easywallet.nfc.EasyCardReader
import tw.easywallet.nfc.KeyStoreFile

/** What the tap sheet is currently showing. */
sealed interface ScanState {
    data object Idle : ScanState
    data object Waiting : ScanState
    data object Reading : ScanState
    data class Done(val snapshot: CardSnapshot, val card: CardEntity) : ScanState
    data class Error(val reason: ReadFailure) : ScanState
}

class WalletViewModel(
    private val repository: WalletRepository,
    private val reader: EasyCardReader,
    private val keyStore: KeyStoreFile
) : ViewModel() {

    val cards: StateFlow<List<CardEntity>> = repository.observeCards()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _scanState = MutableStateFlow<ScanState>(ScanState.Idle)
    val scanState: StateFlow<ScanState> = _scanState.asStateFlow()

    /**
     * Raw sector dumps from this session, by UID. Deliberately in memory only:
     * a full dump of a card you own is still card data, and there is no reason
     * for it to outlive the app process on disk.
     */
    private val _dumps = MutableStateFlow<Map<String, CardSnapshot>>(emptyMap())
    val dumps: StateFlow<Map<String, CardSnapshot>> = _dumps.asStateFlow()

    private val _keyCount = MutableStateFlow(keyStore.userKeyCount())
    val keyCount: StateFlow<Int> = _keyCount.asStateFlow()

    fun beginScan() {
        _scanState.value = ScanState.Waiting
    }

    fun dismissScan() {
        _scanState.value = ScanState.Idle
    }

    /**
     * Called from the NFC reader-mode callback, which runs on a binder thread.
     * The actual transceive is pushed to IO; touching a [Tag] from the main
     * thread is what produces the classic "tag lost" flakiness.
     */
    fun onTagDiscovered(tag: Tag) {
        if (_scanState.value is ScanState.Reading) return
        _scanState.value = ScanState.Reading

        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) { reader.read(tag) }) {
                is EasyCardReader.Result.Success -> {
                    val card = repository.saveScan(result.snapshot)
                    _dumps.value = _dumps.value + (result.snapshot.uid to result.snapshot)
                    _scanState.value = ScanState.Done(result.snapshot, card)
                }
                is EasyCardReader.Result.Failure ->
                    _scanState.value = ScanState.Error(result.reason)
            }
        }
    }

    fun importKeys(content: String) {
        keyStore.importFrom(content)
        _keyCount.value = keyStore.userKeyCount()
    }

    fun clearKeys() {
        keyStore.clear()
        _keyCount.value = 0
    }

    fun rename(uid: String, nickname: String) = viewModelScope.launch {
        repository.rename(uid, nickname.ifBlank { "EasyCard" })
    }

    fun delete(uid: String) = viewModelScope.launch { repository.delete(uid) }

    fun observeCard(uid: String) = repository.observeCard(uid)
    fun observeTxns(uid: String) = repository.observeTxns(uid)
    fun observeSamples(uid: String) = repository.observeSamples(uid)

    class Factory(
        private val repository: WalletRepository,
        private val reader: EasyCardReader,
        private val keyStore: KeyStoreFile
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            WalletViewModel(repository, reader, keyStore) as T
    }
}
