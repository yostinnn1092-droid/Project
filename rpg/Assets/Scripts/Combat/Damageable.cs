using UnityEngine;
using UnityEngine.Events;

namespace Rpg.Combat
{
    /// <summary>
    /// Anything that can be hit — the player, a wolf, a training dummy. Kept
    /// deliberately ignorant of WHO hit it and why: attackers describe a blow
    /// with a <see cref="Blow"/> and this decides what it does to the body.
    ///
    /// Poise is the part worth understanding. A body does not stagger on every
    /// hit; it accumulates the impact of hits and staggers when that crosses a
    /// threshold, then the pool refills. That is what stops a fast weapon from
    /// locking a large enemy in permanent flinch, and what makes a heavy weapon
    /// worth swinging even though it is slower.
    /// </summary>
    public class Damageable : MonoBehaviour
    {
        [Header("Life")]
        [SerializeField] private float maxHealth = 100f;

        [Header("Poise")]
        [Tooltip("Impact absorbed before this body staggers. Higher = harder to interrupt.")]
        [SerializeField] private float maxPoise = 40f;
        [Tooltip("Poise regained per second once it has been a moment since the last hit.")]
        [SerializeField] private float poiseRegen = 20f;
        [Tooltip("Quiet time before poise starts coming back.")]
        [SerializeField] private float poiseRegenDelay = 1.2f;

        [Header("Feel")]
        [Tooltip("Seconds the whole game freezes when this body is struck.")]
        [SerializeField] private float hitstopOnDamage = 0.07f;
        [Tooltip("Extra freeze when a blow staggers. A stagger should read louder than a chip.")]
        [SerializeField] private float hitstopOnStagger = 0.12f;

        [Header("Events")]
        // Constructed here, not left to Unity. A generic UnityEvent<T> is NOT
        // serializable, so Unity does not create one for you the way it does for
        // a plain UnityEvent — the field stays null and the first AddListener
        // throws. Being generic also means these do not appear in the inspector;
        // subscribe from code.
        public UnityEvent<Blow> OnHit = new UnityEvent<Blow>();
        public UnityEvent<Blow> OnStagger = new UnityEvent<Blow>();
        public UnityEvent OnDeath = new UnityEvent();

        public float Health { get; private set; }
        public float MaxHealth => maxHealth;
        public bool IsDead => Health <= 0f;
        /// <summary>Set by the owner while dodging, or during a boss's armoured phase.</summary>
        public bool Invulnerable { get; set; }

        /// <summary>
        /// While true, a blow that would kill leaves a sliver instead. Set by
        /// <see cref="Monsters.Subduable"/> on anything that can be taken alive,
        /// and cleared the moment it goes down — so the NEXT blow finishes it.
        /// That switch is the entire tension of taming: the creature breaks, and
        /// then it is on the player to stop.
        /// </summary>
        public bool PreventDeath { get; set; }

        private float _poise;
        private float _quietFor;

        private void Awake()
        {
            Health = maxHealth;
            _poise = maxPoise;
        }

        private void Update()
        {
            if (IsDead) return;
            _quietFor += Time.deltaTime;
            if (_quietFor >= poiseRegenDelay && _poise < maxPoise)
                _poise = Mathf.Min(maxPoise, _poise + poiseRegen * Time.deltaTime);
        }

        /// <summary>
        /// Returns true if the blow actually landed. A caller uses that to decide
        /// whether to spawn an impact effect, so a hit on an invulnerable body
        /// stays silent rather than showing sparks off a dodge.
        /// </summary>
        public bool TakeHit(Blow blow)
        {
            if (IsDead || Invulnerable) return false;

            Health = Mathf.Max(0f, Health - blow.Damage);
            _poise -= blow.Impact;
            _quietFor = 0f;

            // Caught before the events fire, not after. A creature that can be
            // subdued must be left ALIVE by the blow that breaks it, and it must
            // already be alive by the time OnHit runs — that is where Subduable
            // decides to collapse it, and it will not collapse something it has
            // been told is dead.
            //
            // Without this, a heavy weapon taking a wolf from a fifth of its
            // health straight to zero would kill it outright and the player would
            // simply never see the window they are meant to be watching for.
            if (Health <= 0f && PreventDeath) Health = Mathf.Max(1f, maxHealth * 0.02f);

            bool staggered = _poise <= 0f;
            if (staggered) _poise = maxPoise;

            Core.Hitstop.Freeze(staggered ? hitstopOnStagger : hitstopOnDamage);

            OnHit?.Invoke(blow);
            if (staggered) OnStagger?.Invoke(blow);

            if (Health <= 0f) OnDeath?.Invoke();
            return true;
        }

        public void Heal(float amount)
        {
            if (IsDead) return;
            Health = Mathf.Min(maxHealth, Health + Mathf.Max(0f, amount));
        }

        /// <summary>
        /// Kill outright, ignoring invulnerability. Exists for the finishing blow
        /// on a subdued creature: it is made untouchable while it is down so a
        /// stray hit from elsewhere cannot rob the player of a naming, but a
        /// deliberate strike still has to be able to end it.
        /// </summary>
        public void Kill()
        {
            if (IsDead) return;
            Health = 0f;
            Invulnerable = false;
            OnDeath?.Invoke();
        }

        /// <summary>
        /// Scale up a creature that has just been named. Applied to the ceiling
        /// as well as the current value, so a familiar is permanently stronger
        /// rather than briefly overhealed.
        /// </summary>
        public void ScaleMaxHealth(float multiplier)
        {
            if (multiplier <= 0f) return;
            float ratio = maxHealth > 0f ? Health / maxHealth : 1f;
            maxHealth *= multiplier;
            Health = maxHealth * ratio;
        }
    }

    /// <summary>
    /// One blow, described by the attacker. A struct so it costs nothing to pass
    /// around and cannot be held onto and mutated after the fact.
    /// </summary>
    public struct Blow
    {
        /// <summary>Health removed.</summary>
        public float Damage;
        /// <summary>Poise removed. Separate from damage so a heavy club can rock a
        /// body without out-damaging a dagger, which is the whole point of weight.</summary>
        public float Impact;
        /// <summary>Where the blow came FROM, normalised. Used to throw the body
        /// and to pick a left/right/back stagger animation.</summary>
        public Vector3 Direction;
        /// <summary>World point of contact, for sparks and blood decals.</summary>
        public Vector3 Point;
        /// <summary>Who swung. Lets an enemy turn on whoever hurt it, and lets a
        /// named familiar avoid retaliating against its own master.</summary>
        public GameObject Source;
        /// <summary>Metres of knockback to apply.</summary>
        public float Knockback;
    }
}
