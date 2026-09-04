using System;
using System.Collections;
using UnityEngine;
using Rpg.Combat;

namespace Rpg.Monsters
{
    /// <summary>
    /// The window in which a creature can be named instead of killed.
    ///
    /// Worn down past a threshold it COLLAPSES rather than dying: helpless, on
    /// the ground, for a few seconds. Land another blow in that window and it
    /// dies like anything else. Leave it alone too long and it gets back up.
    ///
    /// The whole design of the naming system is in that sentence. Taming is not
    /// a menu option or a thrown net — it is the ability to notice a creature
    /// break and to STOP HITTING IT. That is genuinely hard here, because
    /// attacks in this game commit and cannot be called off once started, so a
    /// greedy third swing is exactly how a player loses the wolf they wanted.
    /// The combat system's weight and the naming system's difficulty turn out to
    /// be the same mechanic looked at from two sides.
    /// </summary>
    [RequireComponent(typeof(Damageable))]
    [RequireComponent(typeof(MonsterIdentity))]
    public class Subduable : MonoBehaviour
    {
        [Header("Collapse")]
        [Tooltip("Fraction of health at which it breaks rather than dies. Higher " +
                 "makes taming easier and killing harder to do by accident.")]
        [Range(0.02f, 0.5f)][SerializeField] private float collapseAt = 0.15f;
        [Tooltip("Seconds it stays down. This is the player's window to stop, " +
                 "walk over and name it — long enough to cross a few metres, " +
                 "short enough that it is a scramble.")]
        [SerializeField] private float downFor = 6f;
        [Tooltip("Health it stands back up with, as a fraction. Low, so a second " +
                 "attempt is quick — losing the window should cost time, not the " +
                 "whole fight over again.")]
        [Range(0.05f, 1f)][SerializeField] private float recoverTo = 0.3f;

        [Header("Refs")]
        [Tooltip("Disabled while it is down and re-enabled if it recovers. " +
                 "Usually the monster's own AI component.")]
        [SerializeField] private MonoBehaviour brain;

        public bool IsDown { get; private set; }
        /// <summary>Seconds left in the naming window, for a prompt to count down.</summary>
        public float DownRemaining { get; private set; }

        public event Action OnCollapsed;
        public event Action OnRecovered;

        private Damageable _health;
        private MonsterIdentity _identity;
        private Coroutine _downRoutine;

        private void Awake()
        {
            _health = GetComponent<Damageable>();
            _identity = GetComponent<MonsterIdentity>();
            _health.OnHit.AddListener(OnHit);
            // Armed from the start: anything tameable is worn down rather than
            // killed, so the window always appears at least once.
            _health.PreventDeath = true;
        }

        private void OnHit(Blow blow)
        {
            if (_health.IsDead) return;

            if (IsDown)
            {
                // Already broken, and hit again. This is the mistake the whole
                // mechanic is built around, so it is not softened: the creature
                // dies and the name is lost with it.
                _health.Kill();
                return;
            }

            // Family is not prey. Named creatures obviously, but also pack
            // members, who joined under their leader and so carry no name of
            // their own. Without the second half, a wolf that came with its
            // leader would still collapse in fights — and every recovery
            // re-arms the death guard, leaving a familiar that flops over
            // repeatedly and cannot be killed for the rest of the game.
            if (IsSpokenFor) return;

            if (_health.Health <= _health.MaxHealth * collapseAt) Collapse();
        }

        private void Collapse()
        {
            if (IsDown) return;
            IsDown = true;

            // NOT invulnerable. An earlier version made it so, reasoning that a
            // stray hit should not rob the player of a naming — and that quietly
            // broke the whole mechanic, because Damageable drops an invulnerable
            // body's hit BEFORE raising OnHit, so the finishing blow above could
            // never fire and a downed creature could never be killed at all.
            //
            // The death guard comes off instead. From here a hit is a hit.
            _health.PreventDeath = false;
            if (brain != null) brain.enabled = false;

            OnCollapsed?.Invoke();
            _downRoutine = StartCoroutine(StayDown());
        }

        private IEnumerator StayDown()
        {
            DownRemaining = downFor;
            while (DownRemaining > 0f)
            {
                DownRemaining -= Time.deltaTime;
                yield return null;
            }
            Recover();
        }

        private void Recover()
        {
            if (!IsDown) return;
            IsDown = false;
            DownRemaining = 0f;
            _health.PreventDeath = true;      // it can be broken again
            _health.Heal(_health.MaxHealth * recoverTo);
            if (brain != null) brain.enabled = true;
            OnRecovered?.Invoke();
            _downRoutine = null;
        }

        /// <summary>
        /// Called when the naming succeeds. Ends the window without healing it
        /// back to fighting strength — a new familiar gets up hurt, which is a
        /// quiet reason to care about the thing you just took in.
        /// </summary>
        public void ConsumeForNaming()
        {
            if (_downRoutine != null) StopCoroutine(_downRoutine);
            _downRoutine = null;
            IsDown = false;
            DownRemaining = 0f;
            // A creature that has joined you dies like anything else. Keeping the
            // guard on would make every familiar quietly unkillable.
            _health.PreventDeath = false;
            // Switched off by Collapse, and nothing else will switch it back on
            // now that the recovery timer has been cancelled.
            if (brain != null) brain.enabled = true;
        }

        /// <summary>
        /// True if a player standing here could name it right now.
        ///
        /// A creature that already answers to someone is excluded even though it
        /// has no name of its own: pack members join under their leader, so
        /// without this the player could tame a leader for one slot and then
        /// name each of its wolves individually, which is precisely the rule the
        /// pack design exists to enforce.
        /// </summary>
        public bool CanBeNamed => IsDown && !_health.IsDead && !IsSpokenFor;

        /// <summary>Already belongs to someone, named or not.</summary>
        private bool IsSpokenFor => _identity.IsNamed || GetComponent<Familiar>() != null;
    }
}
