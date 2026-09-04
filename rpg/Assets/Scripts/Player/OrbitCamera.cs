using UnityEngine;

namespace Rpg.Player
{
    /// <summary>
    /// Third-person camera on a spring arm. Hand-rolled rather than Cinemachine
    /// so there is one less package to install and one less thing to mis-wire
    /// before the game will run at all; swapping to Cinemachine later changes
    /// nothing outside this file, because everything else asks the camera only
    /// for its forward direction.
    ///
    /// Runs in LateUpdate so it reads the body's FINAL position for the frame.
    /// In Update it would chase a position the player has already left, which is
    /// the usual cause of a camera that judders when you run.
    /// </summary>
    public class OrbitCamera : MonoBehaviour
    {
        [Header("Target")]
        [SerializeField] private Transform target;
        [Tooltip("Aim point above the feet — roughly the chest.")]
        [SerializeField] private Vector3 targetOffset = new Vector3(0f, 1.5f, 0f);

        [Header("Arm")]
        [SerializeField] private float distance = 4.5f;
        [Tooltip("Shoulder offset. A little to the side reads as over-the-shoulder " +
                 "rather than a drone directly behind the head.")]
        [SerializeField] private float shoulder = 0.6f;

        [Header("Look")]
        [SerializeField] private float sensitivity = 220f;
        [SerializeField] private float minPitch = -35f;
        [SerializeField] private float maxPitch = 65f;
        [Tooltip("Invert this if pulling the mouse back should look down.")]
        [SerializeField] private bool invertY = false;

        [Header("Collision")]
        [Tooltip("What the arm should not pass through. Exclude the player's own " +
                 "layer, or the camera collides with the head it is following.")]
        [SerializeField] private LayerMask collideWith = ~0;
        [Tooltip("Keeps the near plane out of the wall it stops against.")]
        [SerializeField] private float collisionPadding = 0.25f;

        [Header("Smoothing")]
        [Tooltip("Seconds to catch up. Small: a camera that lags in combat costs " +
                 "the player the information they are fighting on.")]
        [SerializeField] private float followSmoothing = 0.04f;

        private float _yaw;
        private float _pitch = 15f;
        private Vector3 _velocity;

        private void Start()
        {
            if (target == null)
            {
                var found = GameObject.FindGameObjectWithTag("Player");
                if (found != null) target = found.transform;
            }
            Cursor.lockState = CursorLockMode.Locked;
            Cursor.visible = false;
        }

        private void LateUpdate()
        {
            if (target == null) return;

            _yaw += Input.GetAxisRaw("Mouse X") * sensitivity * Time.deltaTime;
            float dy = Input.GetAxisRaw("Mouse Y") * sensitivity * Time.deltaTime;
            _pitch = Mathf.Clamp(_pitch + (invertY ? dy : -dy), minPitch, maxPitch);

            Quaternion rot = Quaternion.Euler(_pitch, _yaw, 0f);
            Vector3 pivot = target.position + targetOffset + rot * Vector3.right * shoulder;

            // Sweep the arm rather than raycasting a line: a thin ray slips
            // through railings and fence posts and drops the camera outside the
            // world, which is the classic third-person failure.
            float wanted = distance;
            if (Physics.SphereCast(pivot, collisionPadding, -(rot * Vector3.forward),
                                   out RaycastHit hit, distance, collideWith,
                                   QueryTriggerInteraction.Ignore))
            {
                wanted = Mathf.Max(0.4f, hit.distance - collisionPadding);
            }

            Vector3 wantedPos = pivot - rot * Vector3.forward * wanted;
            transform.position = Vector3.SmoothDamp(
                transform.position, wantedPos, ref _velocity, followSmoothing);
            transform.rotation = rot;
        }

        /// <summary>Point the camera at a heading — used when locking onto a target.</summary>
        public void SetYaw(float yaw) => _yaw = yaw;
    }
}
