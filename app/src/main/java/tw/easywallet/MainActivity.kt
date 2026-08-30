package tw.easywallet

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.flow.map
import tw.easywallet.nfc.NfcReaderController
import tw.easywallet.ui.ScanState
import tw.easywallet.ui.WalletViewModel
import tw.easywallet.ui.screens.CardDetailScreen
import tw.easywallet.ui.screens.ScanSheet
import tw.easywallet.ui.screens.SettingsScreen
import tw.easywallet.ui.screens.WalletScreen
import tw.easywallet.ui.theme.EasyWalletTheme

class MainActivity : ComponentActivity() {

    private lateinit var nfc: NfcReaderController
    private var viewModel: WalletViewModel? = null

    /**
     * SAF picker for the key file. Using the document picker rather than a storage
     * permission means the app never gets blanket file access — the user hands it
     * exactly one file.
     */
    private val pickKeyFile = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        uri ?: return@registerForActivityResult
        val text = contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
        if (text != null) viewModel?.importKeys(text)
    }

    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        nfc = NfcReaderController(this)

        val app = application as EasyWalletApp

        setContent {
            EasyWalletTheme {
                val vm: WalletViewModel = viewModel(
                    factory = WalletViewModel.Factory(app.repository, app.reader, app.keyStore)
                )
                viewModel = vm
                AppNavHost(vm, nfc, onPickKeyFile = { pickKeyFile.launch(arrayOf("*/*")) })
            }
        }

        // A tap that launched the app from the background arrives as an intent
        // rather than through reader mode.
        handleTagIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleTagIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        // Reader mode is only worth holding while we're actually foreground; keeping
        // it on in the background would swallow taps meant for other apps.
        nfc.enable { tag -> viewModel?.onTagDiscovered(tag) }
    }

    override fun onPause() {
        super.onPause()
        nfc.disable()
    }

    private fun handleTagIntent(intent: Intent?) {
        val action = intent?.action ?: return
        if (action != NfcAdapter.ACTION_TECH_DISCOVERED &&
            action != NfcAdapter.ACTION_TAG_DISCOVERED
        ) return

        val tag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Tag>(NfcAdapter.EXTRA_TAG)
        }

        tag?.let {
            viewModel?.beginScan()
            viewModel?.onTagDiscovered(it)
        }
    }
}

private object Routes {
    const val WALLET = "wallet"
    const val SETTINGS = "settings"
    const val CARD = "card/{uid}"
    fun card(uid: String) = "card/$uid"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppNavHost(
    vm: WalletViewModel,
    nfc: NfcReaderController,
    onPickKeyFile: () -> Unit
) {
    val nav = rememberNavController()
    val cards by vm.cards.collectAsState()
    val scanState by vm.scanState.collectAsState()
    val keyCount by vm.keyCount.collectAsState()
    val dumps by vm.dumps.collectAsState()

    NavHost(navController = nav, startDestination = Routes.WALLET) {

        composable(Routes.WALLET) {
            WalletScreen(
                cards = cards,
                onScan = { vm.beginScan() },
                onOpenCard = { nav.navigate(Routes.card(it)) },
                onOpenSettings = { nav.navigate(Routes.SETTINGS) }
            )
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(
                keyCount = keyCount,
                nfcSupported = nfc.isNfcSupported,
                onBack = { nav.popBackStack() },
                onImportKeys = onPickKeyFile,
                onClearKeys = { vm.clearKeys() }
            )
        }

        composable(Routes.CARD) { entry ->
            val uid = entry.arguments?.getString("uid").orEmpty()
            val card by vm.observeCard(uid).collectAsState(initial = null)
            val txns by vm.observeTxns(uid).collectAsState(initial = emptyList())
            val samples by vm.observeSamples(uid).collectAsState(initial = emptyList())

            card?.let {
                CardDetailScreen(
                    card = it,
                    txns = txns,
                    samples = samples,
                    dump = dumps[uid],
                    onBack = { nav.popBackStack() },
                    onRename = { name -> vm.rename(uid, name) },
                    onDelete = { vm.delete(uid); nav.popBackStack() }
                )
            }
        }
    }

    ScanSheet(
        state = scanState,
        nfcEnabled = nfc.isNfcEnabled,
        onDismiss = { vm.dismissScan() },
        onOpenKeySettings = { vm.dismissScan(); nav.navigate(Routes.SETTINGS) }
    )
}
