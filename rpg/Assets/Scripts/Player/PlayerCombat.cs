using System;
using System.Collections;
using UnityEngine;
using Rpg.Combat;

namespace Rpg.Player
{
    /// <summary>
    /// One swing, described as three phases. Tuned in the inspector rather than
    /// read off animation events on purpose: it has to be possible to feel the
    /// combat out with capsules, months before any bought animation is wired in,
    /// and the numbers here are the ones worth arguing about.
    /// </summary>
    [Serializable]
    public class AttackStep
    {
        public string name = "Slash";

        [Header("Timing (seconds)")]
        [Tooltip("Committed. The swing cannot be called off once this begins — " +
                 "that commitment IS the weight. Long windups read heavy, and " +
                 "give an enemy something to punish.")]
        public float windup = 0.18f;
        [Tooltip("Frames the blade can actually hurt something.")]
        public float active = 0.10f;
        [Tooltip("Dead time after. Long enough to be punished, and cancellable " +
                 "into a dodge so it is never a death sentence.")]
        public float recovery = 0.30f;

        [Header("Damage")]
        public float damage = 22f;
        [Tooltip("Poise removed. A heavy step should stagger even when its damage " +
                 "is unremarkable.")]
        public float impact = 15f;
        public float knockback = 2.5f;

        [Header("Motion")]
        [Tooltip("Metres the body drives forward as the blade goes live. A swing " +
                 "that does not travel feels like swatting flies.")]
        public float lunge = 1.6f;

        [Header("Animation (optional)")]
        [Tooltip("Animator trigger to fire on windup. Leave blank until there is art.")]
        public string animatorTrigger = "";
    }

    /// <summary>
    /// The attack loop: commit, connect, recover — with a buffer so committing
    /// never costs responsiveness.
    ///
    /// The tension this resolves is the whole design of weighty melee. Commitment
    /// is what gives a blow weight, but a player who presses during a swing and
    /// gets nothing feels the game ignored them. So the press is REMEMBERED and
    /// spent the moment the window opens. The player experiences a responsive
    /// game made of unresponsive attacks, which is the trick.
    /// </summary>
    [RequireComponent(typeof(PlayerLocomotion))]
    public class PlayerCombat : MonoBehaviour
    {
        public enum State { Idle, Windup, Active, Recovery, Dodging }

        [Header("Chain")]
        [Tooltip("Pressed again in time, the swings run in this order and then " +
                 "start over. Later steps should hit harder and commit longer.")]
        [SerializeField]
        private AttackStep[] chain = new AttackStep[]
        {
            new AttackStep { name = "Slash 1", windup = 0.16f, active = 0.10f, recovery = 0.26f,
                             damage = 20f, impact = 12f, knockback = 2.0f, lunge = 1.5f },
            new AttackStep { name = "Slash 2", windup = 0.14f, active = 0.10f, recovery = 0.28f,
                             damage = 24f, impact = 15f, knockback = 2.4f, lunge = 1.7f },
            new AttackStep { name = "Heavy",   windup = 0.30f, active = 0.14f, recovery = 0.48f,
                             damage = 42f, impact = 34f, knockback = 4.5f, lunge = 2.2f },
        };

        [Header("Buffer")]
        [Tooltip("How long a press is remembered. Too short and committed attacks " +
                 "feel like they eat inputs; too long and the character keeps " +
                 "swinging after the player has stopped asking.")]
        [SerializeField] private float inputBuffer = 0.35f;
        [Tooltip("Fraction of recovery that must elapse before the next chain step " +
                 "can fire. Zero would make the chain a single held button.")]
        [Range(0f, 1f)][SerializeField] private float chainOpensAt = 0.25f;
        [Tooltip("Grace after recovery ends during which the chain still continues " +
                 "rather than restarting at step one.")]
        [SerializeField] private float chainGrace = 0.35f;

        [Header("Dodge")]
        [SerializeField] private float dodgeDistance = 4.5f;
        [SerializeField] private float dodgeDuration = 0.42f;
        [Tooltip("Seconds of invulnerability from the START of the dodge. Shorter " +
                 "than the dodge itself, so a badly timed roll still gets hit.")]
        [SerializeField] private float dodgeIFrames = 0.25f;
        [SerializeField] private float dodgeCooldown = 0.15f;

        [Header("Refs")]
        [SerializeField] private HitBox weaponHitBox;
        [SerializeField] private Damageable self;
        [SerializeField] private Animator animator;

        public State Current { get; private set; } = State.Idle;
        /// <summary>Raised with the step's name each time a swing starts. The class
        /// system listens to this to learn what the player actually does.</summary>
        public event Action<AttackStep> OnAttackStarted;
        public event Action OnDodged;

        private PlayerLocomotion _loco;
        private int _nextStep;
        private float _bufferedUntil = -1f;
        private float _chainValidUntil = -1f;
        private float _dodgeReadyAt;
        private Coroutine _routine;

        private void Awake()
        {
            _loco = GetComponent<PlayerLocomotion>();
            if (self == null) self = GetComponent<Damageable>();
            if (weaponHitBox != null) weaponHitBox.Owner = gameObject;
            if (weaponHitBox != null) weaponHitBox.Close();
        }

        private void Update()
        {
            if (Input.GetButtonDown("Fire1")) _bufferedUntil = Time.time + inputBuffer;

            if (Input.GetKeyDown(KeyCode.Space) && CanDodge())
            {
                StartDodge();
                return;
            }

            if (Current == State.Idle && HasBufferedAttack()) BeginAttack();
        }

        private bool HasBufferedAttack() => Time.time <= _bufferedUntil;
        private void ConsumeBuffer() => _bufferedUntil = -1f;

        private bool CanDodge()
        {
            if (Time.time < _dodgeReadyAt) return false;
            // Everything except a committed swing can be rolled out of. Recovery
            // being cancellable is what keeps commitment fair rather than cruel.
            return Current == State.Idle || Current == State.Recovery;
        }

        private void BeginAttack()
        {
            if (chain == null || chain.Length == 0) return;
            if (_routine != null) StopCoroutine(_routine);
            _routine = StartCoroutine(RunChain());
        }

        /// <summary>
        /// The whole chain, start to finish, in ONE coroutine.
        ///
        /// The obvious way to write this is for each swing to launch the next,
        /// but that means a coroutine calling StopCoroutine on itself and then
        /// starting its replacement — which happens to work and is very hard to
        /// reason about, especially once a dodge can interrupt from outside.
        /// Looping here means there is exactly one routine that owns the body at
        /// any moment, and exactly one place that hands it back.
        /// </summary>
        private IEnumerator RunChain()
        {
            if (Time.time > _chainValidUntil) _nextStep = 0;   // chain lapsed; start over

            bool again = true;
            while (again)
            {
                ConsumeBuffer();
                AttackStep step = chain[Mathf.Clamp(_nextStep, 0, chain.Length - 1)];
                _nextStep = (_nextStep + 1) % chain.Length;

                // Aim it. A swing goes where the stick is pointing at the moment
                // of commitment, or straight ahead if the player is standing
                // still — an attack is a decision about direction, not a lock-on.
                Vector3 aim = _loco.DesiredDirection;
                if (aim.sqrMagnitude > 0.001f) _loco.SnapFacing(aim);

                OnAttackStarted?.Invoke(step);
                if (animator != null && !string.IsNullOrEmpty(step.animatorTrigger))
                    animator.SetTrigger(step.animatorTrigger);

                // ── windup: committed, no stick ────────────────────────────
                Current = State.Windup;
                _loco.MotionLocked = true;
                yield return new WaitForSeconds(step.windup);

                // ── active: the blade is live, the body drives forward ─────
                Current = State.Active;
                if (step.lunge > 0f)
                {
                    // Divided by the active window so the tuning value reads
                    // roughly as metres travelled rather than an opaque force.
                    _loco.AddImpulse(transform.forward * (step.lunge / Mathf.Max(0.01f, step.active)));
                }
                if (weaponHitBox != null)
                {
                    weaponHitBox.Open(new Blow
                    {
                        Damage = step.damage,
                        Impact = step.impact,
                        Knockback = step.knockback,
                        Source = gameObject,
                    });
                }
                yield return new WaitForSeconds(step.active);
                if (weaponHitBox != null) weaponHitBox.Close();

                // ── recovery: punishable, cancellable into a dodge ─────────
                Current = State.Recovery;
                float openAt = step.recovery * chainOpensAt;
                float t = 0f;
                again = false;
                while (t < step.recovery)
                {
                    t += Time.deltaTime;
                    if (t >= openAt && HasBufferedAttack()) { again = true; break; }
                    yield return null;
                }
                _chainValidUntil = Time.time + chainGrace;
            }

            _loco.MotionLocked = false;
            Current = State.Idle;
            _routine = null;
        }

        private void StartDodge()
        {
            if (_routine != null) StopCoroutine(_routine);
            if (weaponHitBox != null) weaponHitBox.Close();
            _routine = StartCoroutine(RunDodge());
        }

        private IEnumerator RunDodge()
        {
            Current = State.Dodging;
            _dodgeReadyAt = Time.time + dodgeDuration + dodgeCooldown;
            OnDodged?.Invoke();

            // Roll where the stick asks, or backwards off a standing start —
            // backing out is what a player reaches for when they are surprised.
            Vector3 dir = _loco.DesiredDirection;
            if (dir.sqrMagnitude < 0.001f) dir = -transform.forward;
            dir.Normalize();
            _loco.SnapFacing(dir);

            _loco.MotionLocked = true;
            _loco.AddImpulse(dir * (dodgeDistance / Mathf.Max(0.01f, dodgeDuration)));
            if (animator != null) animator.SetTrigger("Dodge");

            if (self != null) self.Invulnerable = true;
            float t = 0f;
            while (t < dodgeDuration)
            {
                t += Time.deltaTime;
                if (self != null && t >= dodgeIFrames) self.Invulnerable = false;
                yield return null;
            }
            if (self != null) self.Invulnerable = false;

            _loco.MotionLocked = false;
            Current = State.Idle;
            _routine = null;
        }
    }
}
