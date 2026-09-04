using UnityEngine;

namespace Rpg.Monsters
{
    /// <summary>
    /// The small contract every monster's own AI implements, so that something
    /// else can point it at a target without knowing anything about how it
    /// fights.
    ///
    /// This is the reason a named wolf still fights like a wolf. The obvious way
    /// to build a familiar is to disable the monster's brain and drive it with a
    /// generic "pet" script — and then every creature in the game moves the same,
    /// and naming a Minotaur gets you a large wolf. Here the familiar layer only
    /// decides WHERE to be and WHO to fight; the monster keeps deciding HOW,
    /// which is the part that makes it a Minotaur.
    ///
    /// It also means every future monster becomes tameable for free: implement
    /// these three members and the whole naming system works on it.
    /// </summary>
    public interface IMonsterBrain
    {
        /// <summary>Who to fight. Null tells it to disengage.</summary>
        void SetTarget(Transform target);

        /// <summary>
        /// Where to be when it has nobody to fight. A wild monster's home is the
        /// ground it guards; a familiar's is whoever named it.
        /// </summary>
        void SetHome(Transform home, float leash);

        /// <summary>
        /// Stop being wild. From here it fights what it is told to and nothing
        /// else — in particular, it stops hunting the person who just named it.
        /// </summary>
        void Tame();

        /// <summary>Currently fighting something.</summary>
        bool Engaged { get; }
    }
}
