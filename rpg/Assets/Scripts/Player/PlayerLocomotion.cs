using UnityEngine;

namespace Rpg.Player
{
    /// <summary>
    /// Ground movement for the player. Built on CharacterController rather than
    /// a Rigidbody: an action game wants movement that answers the stick exactly
    /// and never argues with physics, and a controller gives that for free.
    ///
    /// Combat drives this rather than fighting it. <see cref="MotionLocked"/>
    /// takes the stick away during a committed swing, and <see cref="AddImpulse"/>
    /// is how a lunge or a knockback moves the body while it is locked. Without
    /// that split, either attacks slide the player around under stick control
    /// (which reads as ice) or combat has to reimplement movement.
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    public class PlayerLocomotion : MonoBehaviour
    {
        [Header("Speeds")]
        [SerializeField] private float walkSpeed = 2.2f;
        [SerializeField] private float runSpeed = 5.4f;
        [Tooltip("How fast the body reaches the speed being asked of it. Low " +
                 "values feel like mud, high values feel weightless.")]
        [SerializeField] private float acceleration = 14f;
        [Tooltip("Degrees per second the body turns toward where it is going.")]
        [SerializeField] private float turnSpeed = 900f;

        [Header("Gravity")]
        [SerializeField] private float gravity = -22f;
        [Tooltip("Held downward push while grounded. Zero lets the controller " +
                 "skip off small steps and stutter on slopes.")]
        [SerializeField] private float groundedStick = -2f;

        [Header("Impulses")]
        [Tooltip("How quickly a lunge or knockback bleeds away, per second.")]
        [SerializeField] private float impulseDamping = 9f;

        [Header("Refs")]
        [Tooltip("Leave empty to use Camera.main. Movement is relative to this.")]
        [SerializeField] private Transform cameraTransform;
        [Tooltip("Optional. Left empty the rig still moves, so systems can be " +
                 "tested on a capsule long before any art exists.")]
        [SerializeField] private Animator animator;

        /// <summary>True while an attack owns the body. The stick is ignored.</summary>
        public bool MotionLocked { get; set; }
        /// <summary>Planar speed this frame, for animator blending and footsteps.</summary>
        public float CurrentSpeed { get; private set; }
        /// <summary>Where the stick is pointing in world space, or zero.</summary>
        public Vector3 DesiredDirection { get; private set; }
        public bool IsGrounded => _controller.isGrounded;

        private CharacterController _controller;
        private Vector3 _planarVelocity;
        private Vector3 _impulse;
        private float _verticalVelocity;

        private static readonly int SpeedParam = Animator.StringToHash("Speed");
        private static readonly int GroundedParam = Animator.StringToHash("Grounded");

        private void Awake()
        {
            _controller = GetComponent<CharacterController>();
            if (cameraTransform == null && Camera.main != null)
                cameraTransform = Camera.main.transform;
        }

        private void Update()
        {
            Vector3 wish = ReadStickAsWorldDirection();
            DesiredDirection = wish;

            bool running = Input.GetKey(KeyCode.LeftShift);
            float targetSpeed = MotionLocked ? 0f
                              : wish.sqrMagnitude > 0.001f ? (running ? runSpeed : walkSpeed)
                              : 0f;

            Vector3 targetVelocity = wish * targetSpeed;
            _planarVelocity = Vector3.MoveTowards(
                _planarVelocity, targetVelocity, acceleration * Time.deltaTime);

            // Face where you are going. Not done while locked: an attack should
            // point where it was aimed, and combat steers the facing itself.
            if (!MotionLocked && wish.sqrMagnitude > 0.001f)
            {
                Quaternion want = Quaternion.LookRotation(wish, Vector3.up);
                transform.rotation = Quaternion.RotateTowards(
                    transform.rotation, want, turnSpeed * Time.deltaTime);
            }

            ApplyGravity();

            _impulse = Vector3.MoveTowards(
                _impulse, Vector3.zero, impulseDamping * Time.deltaTime);

            Vector3 motion = _planarVelocity + _impulse;
            motion.y = _verticalVelocity;
            _controller.Move(motion * Time.deltaTime);

            CurrentSpeed = new Vector3(_planarVelocity.x, 0f, _planarVelocity.z).magnitude;

            if (animator != null)
            {
                // Normalised so one animator works whatever the speeds are tuned to.
                animator.SetFloat(SpeedParam, CurrentSpeed / Mathf.Max(0.01f, runSpeed), 0.1f, Time.deltaTime);
                animator.SetBool(GroundedParam, _controller.isGrounded);
            }
        }

        private void ApplyGravity()
        {
            if (_controller.isGrounded && _verticalVelocity < 0f)
                _verticalVelocity = groundedStick;
            else
                _verticalVelocity += gravity * Time.deltaTime;
        }

        /// <summary>
        /// The stick, mapped onto the ground plane as the camera sees it. Pushing
        /// up means "away from the camera" — the only mapping that stays intuitive
        /// while the camera swings around the character.
        /// </summary>
        private Vector3 ReadStickAsWorldDirection()
        {
            float h = Input.GetAxisRaw("Horizontal");
            float v = Input.GetAxisRaw("Vertical");
            Vector3 raw = new Vector3(h, 0f, v);
            if (raw.sqrMagnitude < 0.0001f) return Vector3.zero;
            raw = Vector3.ClampMagnitude(raw, 1f);

            if (cameraTransform == null) return raw;

            Vector3 fwd = cameraTransform.forward; fwd.y = 0f; fwd.Normalize();
            Vector3 right = cameraTransform.right; right.y = 0f; right.Normalize();
            return (fwd * raw.z + right * raw.x).normalized * raw.magnitude;
        }

        /// <summary>A lunge, a dodge, or a knockback. Decays on its own.</summary>
        public void AddImpulse(Vector3 impulse) => _impulse += impulse;

        /// <summary>Turn the body to face a direction immediately, ignoring turn speed.</summary>
        public void SnapFacing(Vector3 direction)
        {
            direction.y = 0f;
            if (direction.sqrMagnitude < 0.0001f) return;
            transform.rotation = Quaternion.LookRotation(direction.normalized, Vector3.up);
        }
    }
}
