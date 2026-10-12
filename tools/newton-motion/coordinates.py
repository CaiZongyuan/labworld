"""Independent double-precision scene kinematics; no Newton, GPU or network imports."""
import math


def normalize(q):
    norm = math.sqrt(sum(x * x for x in q))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError('Invalid scene quaternion')
    return tuple(x / norm for x in q)


def multiply(a, b):
    x, y, z, w = a
    X, Y, Z, W = b
    return (w * X + x * W + y * Z - z * Y,
            w * Y - x * Z + y * W + z * X,
            w * Z + x * Y - y * X + z * W,
            w * W - x * X - y * Y - z * Z)


def rotate(q, p):
    q = normalize(q)
    v = multiply(multiply(q, (*p, 0)), (-q[0], -q[1], -q[2], q[3]))
    return v[:3]


def compose(a, b):
    offset = rotate(a[1], b[0])
    return tuple(a[0][i] + offset[i] for i in range(3)), normalize(multiply(a[1], b[1]))


BASIS = (-math.sqrt(0.5), 0, 0, math.sqrt(0.5))


def wire_pose(p, q):
    return {'position': rotate(BASIS, p),
            'quaternion': normalize(multiply(multiply(BASIS, q), (-BASIS[0], 0, 0, BASIS[3])))}


def native_pose(p, q):
    inverse = (-BASIS[0], 0, 0, BASIS[3])
    return {'position': rotate(inverse, p), 'quaternion': normalize(multiply(multiply(inverse,q),BASIS))}


def source_pose(element):
    p = tuple(float(x) for x in element.get('pos', '0 0 0').split())
    w, x, y, z = (float(x) for x in element.get('quat', '1 0 0 0').split())
    return p, normalize((x, y, z, w))


def forward_kinematics(world, joints):
    result = {}
    def visit(body, parent):
        pose = compose(parent, source_pose(body))
        for joint in body.findall('joint'):
            angle = joints[joint.get('name')]
            axis = [float(v) for v in joint.get('axis', '0 0 1').split()]
            q = tuple(v * math.sin(angle / 2) for v in axis) + (math.cos(angle / 2),)
            pose = compose(pose, ((0, 0, 0), q))
        result[body.get('name')] = pose
        for child in body.findall('body'):
            visit(child, pose)
    for body in world.findall('body'):
        visit(body, ((0, 0, 0), (0, 0, 0, 1)))
    return result
