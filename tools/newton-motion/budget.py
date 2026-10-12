"""Fail-closed logical native budgets; no solver or GPU imports."""


class NativeBudgetError(RuntimeError):
    def __init__(self, phase, snapshot, reason):
        self.phase = phase
        self.snapshot = snapshot
        super().__init__('Newton native budget rejected at ' + phase + ': ' + reason)


def validate_native_budget(snapshot, phase, initial=False):
    required = {'nworld','naconmax','njmax','nacon','ncollision','nefc','overflow'}
    if initial:
        required |= {'cpu_ncon','cpu_nefc'}
    missing = required - snapshot.keys()
    if missing:
        raise NativeBudgetError(phase,snapshot,'missing actual getters ' + ','.join(sorted(missing)))
    if any(type(snapshot[key]) is not int for key in required):
        raise NativeBudgetError(phase,snapshot,'actual getters must be logical integers')
    if snapshot['nworld'] != 1 or snapshot['naconmax'] != 256 or snapshot['njmax'] != 512:
        raise NativeBudgetError(phase,snapshot,'actual capacity must be one world, 256 contacts and 512 constraints')
    for key,limit in [('nacon',256),('ncollision',256),('nefc',512),('cpu_ncon',256),('cpu_nefc',512)]:
        if key in required and not 0 <= snapshot[key] <= limit:
            raise NativeBudgetError(phase,snapshot,key + ' exceeds its fixed logical budget')
    if snapshot['overflow'] != 0:
        raise NativeBudgetError(phase,snapshot,'native overflow bitmask is nonzero')
