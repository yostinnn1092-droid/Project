using UnityEngine;

namespace Rpg.Combat
{
    /// <summary>
    /// Turns the knockback on a <see cref="Blow"/> into actual movement.
    ///
    /// Separate from <see cref="Damageable"/> because not everything that can be
    /// hurt should be movable — a door, a siege engine, or a Cyclops mid-slam
    /// takes damage without budging, and that immovability is characterisation.
    /// Leave this component off and the body simply does not flinch.
    ///
    /// Works on the CharacterController directly rather than through the player's
    /// locomotion so it can sit on anything, player or monster alike.
    /// </summary>
    [RequireComponent(typeof(Damageable))]
    public class KnockbackReceiver : MonoBehaviour
    {
        [Tooltip("Multiplier on incoming knockback. Heavier bodies should shrug " +
                 "off what throws a goblin.")]
        [SerializeField] private float resistance = 1f;
        [Tooltip("How fast the shove bleeds off, metres per second per second.")]
        [SerializeField] private float damping = 14f;

        private CharacterController _controller;
        private Vector3 _velocity;

        private void Awake()
        {
            _controller = GetComponent<CharacterController>();
            GetComponent<Damageable>().OnHit.AddListener(Receive);
        }

        private void Receive(Blow blow)
        {
            if (blow.Knockback <= 0f) return;
            Vector3 push = blow.Direction;
            push.y = 0f;                       // never lift; a floating body reads as a glitch
            if (push.sqrMagnitude < 0.0001f) return;
            _velocity += push.normalized * (blow.Knockback * resistance);
        }

        private void Update()
        {
            if (_velocity.sqrMagnitude < 0.0001f) return;
            if (_controller != null && _controller.enabled)
                _controller.Move(_velocity * Time.deltaTime);
            else
                transform.position += _velocity * Time.deltaTime;

            _velocity = Vector3.MoveTowards(_velocity, Vector3.zero, damping * Time.deltaTime);
        }
    }
}
