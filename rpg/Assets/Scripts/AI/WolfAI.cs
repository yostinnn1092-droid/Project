using System.Collections;
using UnityEngine;
using Rpg.Combat;

namespace Rpg.AI
{
    /// <summary>
    /// A wolf. First monster on purpose: it is a pack animal, so it is also the
    /// first test of the leader-and-pack idea the whole naming system rests on.
    ///
    /// The behaviour is deliberately readable rather than clever. A wolf circles
    /// at a distance, picks a moment, telegraphs, and lunges. Every one of those
    /// beats exists so the player can LEARN it — an enemy that closes and bites
    /// on an invisible timer cannot be fought well, only survived. The crouch
    /// before a lunge is the contract: see it, and you have time to roll.
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    [RequireComponent(typeof(Damageable))]
    public class WolfAI : MonoBehaviour
    {
        private enum State { Idle, Chase, Circle, Telegraph, Lunge, Recover, Stagger, Dead }

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
        private CharacterController _controller;
        private Damageable _health;
        private float _verticalVelocity;
        private float _nextAttackAt;
        private int _circleDir = 1;
        private float _circleUntil;
        private Coroutine _act;

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
            var player = GameObject.FindGameObjectWithTag("Player");
            if (player != null) _target = player.transform;
        }

        private void Update()
        {
            if (_state == State.Dead) { Fall(); return; }
            if (_target == null) { Fall(); return; }

            float dist = PlanarDistanceToTarget();

            // Committed states run their own coroutine and must not be steered.
            if (_state == State.Telegraph || _state == State.Lunge ||
                _state == State.Recover || _state == State.Stagger)
            {
                Fall();
                return;
            }

            switch (_state)
            {
                case State.Idle:
                    if (dist <= noticeRange) _state = State.Chase;
                    break;

                case State.Chase:
                    if (dist > loseRange) { _state = State.Idle; break; }
                    FaceTarget();
                    if (dist > circleDistance) MovePlanar(ToTarget() * chaseSpeed);
                    else { _state = State.Circle; PickNewCircle(); }
                    break;

                case State.Circle:
                    if (dist > loseRange) { _state = State.Idle; break; }
                    FaceTarget();
                    // Strafe around, drifting in or out to hold its spacing. The
                    // sideways motion is what makes a pack feel like it is working
                    // the player rather than queueing to be hit.
                    Vector3 toward = ToTarget();
                    Vector3 around = Vector3.Cross(Vector3.up, toward) * _circleDir;
                    float correction = Mathf.Clamp(dist - circleDistance, -1f, 1f);
                    MovePlanar((around + toward * correction).normalized * circleSpeed);

                    if (Time.time >= _circleUntil) PickNewCircle();
                    if (dist <= lungeRange && Time.time >= _nextAttackAt)
                        _act = StartCoroutine(Attack());
                    break;
            }

            if (animator != null)
                animator.SetFloat("Speed", _state == State.Chase ? 1f : _state == State.Circle ? 0.5f : 0f, 0.1f, Time.deltaTime);
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

            // Keep facing the player through the tell, so the lunge goes where
            // the player can see it is going to go.
            float t = 0f;
            while (t < telegraph)
            {
                t += Time.deltaTime;
                FaceTarget();
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
            // that tracks the player mid-flight cannot be dodged, which would
            // make the tell a lie.
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

            _state = State.Circle;
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
            _state = State.Circle;
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
            // is what makes "subdue, then name" possible later.
            enabled = false;
        }

        // ── helpers ─────────────────────────────────────────────────────────
        private Vector3 ToTarget()
        {
            Vector3 d = _target.position - transform.position;
            d.y = 0f;
            return d.sqrMagnitude > 0.0001f ? d.normalized : transform.forward;
        }

        private float PlanarDistanceToTarget()
        {
            Vector3 d = _target.position - transform.position;
            d.y = 0f;
            return d.magnitude;
        }

        private void FaceTarget()
        {
            Quaternion want = Quaternion.LookRotation(ToTarget(), Vector3.up);
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

        private void OnDrawGizmosSelected()
        {
            Gizmos.color = new Color(1f, 0.8f, 0.2f, 0.35f);
            Gizmos.DrawWireSphere(transform.position, noticeRange);
            Gizmos.color = new Color(1f, 0.3f, 0.2f, 0.5f);
            Gizmos.DrawWireSphere(transform.position, lungeRange);
        }
    }
}
