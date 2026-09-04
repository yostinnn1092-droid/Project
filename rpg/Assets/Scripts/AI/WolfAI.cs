using System.Collections;
using UnityEngine;
using Rpg.Combat;
using Rpg.Monsters;

namespace Rpg.AI
{
    /// <summary>
    /// A wolf. First monster on purpose: it is a pack animal, so it is also the
    /// first test of the leader-and-pack idea the naming system rests on.
    ///
    /// The behaviour is deliberately readable rather than clever. A wolf circles
    /// at a distance, picks a moment, telegraphs, and lunges. Every one of those
    /// beats exists so the player can LEARN it — an enemy that closes and bites
    /// on an invisible timer cannot be fought well, only survived. The crouch
    /// before a lunge is the contract: see it, and you have time to roll.
    ///
    /// The same script runs a wild wolf and a named one. A wild wolf hunts
    /// whatever it notices; a named one is handed a target and a place to be by
    /// <see cref="Familiar"/> and is otherwise identical — so taming a wolf gets
    /// you something that still fights like a wolf.
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    [RequireComponent(typeof(Damageable))]
    public class WolfAI : MonoBehaviour, IMonsterBrain
    {
        private enum State { Idle, Chase, Circle, Telegraph, Lunge, Recover, Stagger, Dead }

        [Header("Allegiance")]
        [Tooltip("Wild wolves hunt whatever they notice. Turned off when the wolf " +
                 "is named — from then on it fights what it is told to.")]
        [SerializeField] private bool wild = true;

        [Header("Senses")]
        [SerializeField] private float noticeRange = 14f;
        [SerializeField] private float loseRange = 22f;

        [Header("Movement")]
        [SerializeField] private float chaseSpeed = 4.6f;
        [SerializeField] private float circleSpeed = 2.6f;
        [SerializeField] private float turnSpeed = 540f;
        [SerializeField] private float gravity = -22f;

        [Header("Spacing")]
        [Tooltip("Distance it wants to hold while looking for an opening.")]
        [SerializeField] private float circleDistance = 4.0f;
        [Tooltip("Inside this, it will consider committing to a lunge.")]
        [SerializeField] private float lungeRange = 4.5f;

        [Header("Attack")]
        [Tooltip("The tell. Long enough to see and answer — this number is the " +
                 "difference between a fair enemy and a cheap one.")]
        [SerializeField] private float telegraph = 0.45f;
        [SerializeField] private float lungeDuration = 0.30f;
        [SerializeField] private float lungeSpeed = 11f;
        [SerializeField] private float recovery = 0.65f;
        [SerializeField] private float damage = 12f;
        [SerializeField] private float impact = 10f;
        [SerializeField] private float knockback = 3f;
        [Tooltip("Shortest gap between lunges, so a pack cannot chain-stun.")]
        [SerializeField] private float attackCooldown = 1.4f;

        [Header("Reactions")]
        [SerializeField] private float staggerDuration = 0.5f;

        [Header("Refs")]
        [SerializeField] private HitBox jaws;
        [SerializeField] private Animator animator;

        private State _state = State.Idle;
        private Transform _target;
        private Transform _home;
        private float _leash = 4.5f;
        private CharacterController _controller;
        private Damageable _health;
        private float _verticalVelocity;
        private float _nextAttackAt;
        private int _circleDir = 1;
        private float _circleUntil;
        private Coroutine _act;

        public bool Engaged => _target != null &&
                               _state != State.Idle && _state != State.Dead;

        // ── IMonsterBrain ───────────────────────────────────────────────────
        public void SetTarget(Transform target)
        {
            if (_target == target) return;
            _target = target;
            // Never yank it out of a committed swing: a lunge that stops halfway
            // because orders changed looks like the animation broke.
            if (_state == State.Idle || _state == State.Chase || _state == State.Circle)
                _state = target != null ? State.Chase : State.Idle;
        }

        public void SetHome(Transform home, float leash)
        {
            _home = home;
            _leash = Mathf.Max(0.5f, leash);
        }

        private void Awake()
        {
            _controller = GetComponent<CharacterController>();
            _health = GetComponent<Damageable>();
            if (jaws != null) { jaws.Owner = gameObject; jaws.Close(); }

            _health.OnStagger.AddListener(_ => EnterStagger());
            _health.OnDeath.AddListener(Die);
        }

        private void Start()
        {
            // A wild wolf finds its own quarrel. A named one waits to be told,
            // and BindTo will have handed it a home before this runs.
            if (wild && _target == null)
            {
                var player = GameObject.FindGameObjectWithTag("Player");
                if (player != null) _target = player.transform;
            }
        }

        /// <summary>Called when this wolf is named, so it stops hunting its new master.</summary>
        public void Tame()
        {
            wild = false;
            _target = null;
            if (_state == State.Chase || _state == State.Circle) _state = State.Idle;
        }

        private void Update()
        {
            if (_state == State.Dead) { Fall(); return; }

            // Committed states run their own coroutine and must not be steered.
            if (_state == State.Telegraph || _state == State.Lunge ||
                _state == State.Recover || _state == State.Stagger)
            {
                Fall();
                return;
            }

            if (_target == null || _target.gameObject.activeInHierarchy == false)
            {
                _target = null;
                GoHome();
                return;
            }

            float dist = PlanarDistanceTo(_target);

            switch (_state)
            {
                case State.Idle:
                    if (dist <= noticeRange) _state = State.Chase;
                    else GoHome();
                    break;

                case State.Chase:
                    // A wild wolf gives up when the quarry is far enough away. A
                    // named one keeps its target until its handler withdraws it,
                    // because it was sent deliberately.
                    if (wild && dist > loseRange) { _state = State.Idle; break; }
                    FaceTarget();
                    if (dist > circleDistance) MovePlanar(DirectionTo(_target) * chaseSpeed);
                    else { _state = State.Circle; PickNewCircle(); }
                    break;

                case State.Circle:
                    if (wild && dist > loseRange) { _state = State.Idle; break; }
                    if (dist > circleDistance * 1.6f) { _state = State.Chase; break; }
                    FaceTarget();
                    // Strafe around, drifting in or out to hold its spacing. The
                    // sideways motion is what makes a pack feel like it is working
                    // the player rather than queueing to be hit.
                    Vector3 toward = DirectionTo(_target);
                    Vector3 around = Vector3.Cross(Vector3.up, toward) * _circleDir;
                    float correction = Mathf.Clamp(dist - circleDistance, -1f, 1f);
                    MovePlanar((around + toward * correction).normalized * circleSpeed);

                    if (Time.time >= _circleUntil) PickNewCircle();
                    if (dist <= lungeRange && Time.time >= _nextAttackAt)
                        _act = StartCoroutine(Attack());
                    break;
            }

            Animate();
        }

        /// <summary>
        /// Nothing to fight. Walk back to whoever or whatever it belongs near and
        /// idle there. For a familiar this is what following looks like; for a
        /// wild wolf with a home set it is a territory to hold.
        /// </summary>
        private void GoHome()
        {
            if (_home == null) { Fall(); Animate(0f); return; }

            float d = PlanarDistanceTo(_home);
            if (d > _leash)
            {
                FaceToward(_home.position);
                // Hurries when it has fallen a long way behind, so a follower does
                // not trail further and further during a long run.
                float speed = d > _leash * 2.5f ? chaseSpeed : circleSpeed;
                MovePlanar(DirectionTo(_home) * speed);
                Animate(d > _leash * 2.5f ? 1f : 0.5f);
            }
            else
            {
                Fall();
                Animate(0f);
            }
        }

        private void PickNewCircle()
        {
            _circleDir = Random.value < 0.5f ? -1 : 1;
            _circleUntil = Time.time + Random.Range(0.8f, 2.0f);
        }

        private IEnumerator Attack()
        {
            _state = State.Telegraph;
            if (animator != null) animator.SetTrigger("Telegraph");

            // Keep facing the target through the tell, so the lunge goes where
            // it can be seen to be going.
            float t = 0f;
            while (t < telegraph)
            {
                t += Time.deltaTime;
                if (_target != null) FaceTarget();
                yield return null;
            }

            _state = State.Lunge;
            if (animator != null) animator.SetTrigger("Bite");
            if (jaws != null)
            {
                jaws.Open(new Blow
                {
                    Damage = damage, Impact = impact,
                    Knockback = knockback, Source = gameObject,
                });
            }

            // Committed to the heading chosen at the end of the tell. A lunge
            // that tracks mid-flight cannot be dodged, which would make the tell
            // a lie.
            Vector3 heading = transform.forward;
            t = 0f;
            while (t < lungeDuration)
            {
                t += Time.deltaTime;
                MovePlanar(heading * lungeSpeed);
                yield return null;
            }
            if (jaws != null) jaws.Close();

            _state = State.Recover;
            _nextAttackAt = Time.time + attackCooldown;
            yield return new WaitForSeconds(recovery);

            _state = _target != null ? State.Circle : State.Idle;
            PickNewCircle();
            _act = null;
        }

        private void EnterStagger()
        {
            if (_state == State.Dead) return;
            if (_act != null) StopCoroutine(_act);
            if (jaws != null) jaws.Close();
            _act = StartCoroutine(Stagger());
        }

        private IEnumerator Stagger()
        {
            _state = State.Stagger;
            if (animator != null) animator.SetTrigger("Stagger");
            yield return new WaitForSeconds(staggerDuration);
            _state = _target != null ? State.Circle : State.Idle;
            PickNewCircle();
            _act = null;
        }

        private void Die()
        {
            if (_act != null) StopCoroutine(_act);
            if (jaws != null) jaws.Close();
            _state = State.Dead;
            if (animator != null) animator.SetTrigger("Die");
            // Left in the world rather than destroyed: a body you can walk up to
            // is what makes "subdue, then name" possible.
            enabled = false;
        }

        // ── helpers ─────────────────────────────────────────────────────────
        private Vector3 DirectionTo(Transform t)
        {
            Vector3 d = t.position - transform.position;
            d.y = 0f;
            return d.sqrMagnitude > 0.0001f ? d.normalized : transform.forward;
        }

        private float PlanarDistanceTo(Transform t)
        {
            Vector3 d = t.position - transform.position;
            d.y = 0f;
            return d.magnitude;
        }

        private void FaceTarget() => FaceToward(_target.position);

        private void FaceToward(Vector3 point)
        {
            Vector3 d = point - transform.position;
            d.y = 0f;
            if (d.sqrMagnitude < 0.0001f) return;
            Quaternion want = Quaternion.LookRotation(d.normalized, Vector3.up);
            transform.rotation = Quaternion.RotateTowards(
                transform.rotation, want, turnSpeed * Time.deltaTime);
        }

        private void MovePlanar(Vector3 planarVelocity)
        {
            ApplyGravity();
            Vector3 motion = planarVelocity;
            motion.y = _verticalVelocity;
            _controller.Move(motion * Time.deltaTime);
        }

        private void Fall()
        {
            ApplyGravity();
            _controller.Move(new Vector3(0f, _verticalVelocity, 0f) * Time.deltaTime);
        }

        private void ApplyGravity()
        {
            if (_controller.isGrounded && _verticalVelocity < 0f) _verticalVelocity = -2f;
            else _verticalVelocity += gravity * Time.deltaTime;
        }

        private void Animate()
        {
            Animate(_state == State.Chase ? 1f : _state == State.Circle ? 0.5f : 0f);
        }

        private void Animate(float speed01)
        {
            if (animator != null)
                animator.SetFloat("Speed", speed01, 0.1f, Time.deltaTime);
        }

        private void OnDrawGizmosSelected()
        {
            Gizmos.color = new Color(1f, 0.8f, 0.2f, 0.35f);
            Gizmos.DrawWireSphere(transform.position, noticeRange);
            Gizmos.color = new Color(1f, 0.3f, 0.2f, 0.5f);
            Gizmos.DrawWireSphere(transform.position, lungeRange);
        }
    }
}
