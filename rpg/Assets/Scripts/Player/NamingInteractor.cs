using System;
using UnityEngine;
using Rpg.Monsters;

namespace Rpg.Player
{
    /// <summary>
    /// The player's side of naming: notice a broken creature nearby, offer it,
    /// take a name, hand it to the roster.
    ///
    /// Kept free of any particular UI. It reports what it can see through
    /// <see cref="Prompt"/> and takes a name through <see cref="Confirm"/>, so
    /// the same logic serves a keyboard prompt now and a proper panel later
    /// without being rewritten. <see cref="pendingName"/> is the placeholder
    /// input — a real text field replaces it and nothing else changes.
    /// </summary>
    public class NamingInteractor : MonoBehaviour
    {
        [Header("Reach")]
        [Tooltip("How close you must stand to name something.")]
        [SerializeField] private float reach = 3.0f;
        [SerializeField] private LayerMask monsterLayers = ~0;

        [Header("Input")]
        [SerializeField] private KeyCode nameKey = KeyCode.F;
        [Tooltip("Placeholder for a real text field. Whatever is typed here is " +
                 "the name given when the key is pressed.")]
        [SerializeField] private string pendingName = "Fenrir";

        [Header("Refs")]
        [SerializeField] private FamilyRoster roster;

        /// <summary>
        /// What the HUD should say right now, or empty for nothing. Recomputed
        /// every frame so it follows the naming window's countdown.
        /// </summary>
        public string Prompt { get; private set; } = string.Empty;
        /// <summary>The creature currently in reach and down, if any.</summary>
        public Subduable Candidate { get; private set; }

        public event Action<Familiar> OnNamed;
        public event Action<string> OnRefused;

        private readonly Collider[] _nearby = new Collider[16];

        private void Awake()
        {
            if (roster == null) roster = GetComponent<FamilyRoster>();
        }

        private void Update()
        {
            Candidate = FindCandidate();
            Prompt = BuildPrompt(Candidate);

            if (Candidate != null && Input.GetKeyDown(nameKey)) Confirm(pendingName);
        }

        private Subduable FindCandidate()
        {
            int count = Physics.OverlapSphereNonAlloc(
                transform.position, reach, _nearby, monsterLayers,
                QueryTriggerInteraction.Ignore);

            Subduable best = null;
            float bestDist = float.MaxValue;
            for (int i = 0; i < count; i++)
            {
                var down = _nearby[i].GetComponentInParent<Subduable>();
                if (down == null || !down.CanBeNamed) continue;
                float d = Vector3.Distance(down.transform.position, transform.position);
                if (d < bestDist) { bestDist = d; best = down; }
            }
            return best;
        }

        private string BuildPrompt(Subduable candidate)
        {
            if (candidate == null) return string.Empty;
            var identity = candidate.GetComponent<MonsterIdentity>();
            if (identity == null) return string.Empty;

            // The refusal is shown in place of the offer, rather than letting the
            // player press and be told nothing happened. Standing over a beaten
            // wolf you cannot afford should say so while you can still act on it.
            if (roster != null && !roster.CanName(identity, out string why))
                return $"{identity.Species} — {why}  ({candidate.DownRemaining:0.0}s)";

            float cost = identity.NamingCost;
            return $"[{nameKey}] Name the {identity.Species}  " +
                   $"({Mathf.CeilToInt(cost)} will · {candidate.DownRemaining:0.0}s)";
        }

        /// <summary>Name whatever is in reach. Returns the new familiar, or null.</summary>
        public Familiar Confirm(string name)
        {
            if (Candidate == null || roster == null) return null;
            var identity = Candidate.GetComponent<MonsterIdentity>();
            if (identity == null) return null;

            Familiar familiar = roster.Name(identity, name, out string reason);
            if (familiar == null)
            {
                OnRefused?.Invoke(reason ?? "It cannot be named.");
                return null;
            }

            // Order matters. The creature has to stop being wild BEFORE the
            // window closes and its brain comes back on, or it stands up still
            // hunting the person who just named it.
            //
            // Through the interface, not by asking for a WolfAI: this file
            // should never need editing to support a new monster.
            var brain = Candidate.GetComponent<IMonsterBrain>();
            brain?.Tame();

            // Puts the creature's brain back on as well. That belongs to
            // Subduable, which is what switched it off — doing it from here meant
            // naming a Minotaur would have re-enabled nothing, because this side
            // only knew how to look for a WolfAI.
            Candidate.ConsumeForNaming();

            familiar.Command(FamiliarOrder.Follow);
            OnNamed?.Invoke(familiar);
            return familiar;
        }

        private void OnDrawGizmosSelected()
        {
            Gizmos.color = new Color(0.4f, 1f, 0.6f, 0.4f);
            Gizmos.DrawWireSphere(transform.position, reach);
        }
    }
}
