#!/usr/bin/env python3
#

import sys
import collections
from heapq import heappush, heappop, heapify
from collections import defaultdict
 
def encode(symb2freq):
    """Huffman encode the given dict mapping symbols to weights"""
    heap = [[wt, [sym, ""]] for sym, wt in symb2freq.items()]
    heapify(heap)
    while len(heap) > 1:
        lo = heappop(heap)
        hi = heappop(heap)
        for pair in lo[1:]:
            pair[1] = '0' + pair[1]
        for pair in hi[1:]:
            pair[1] = '1' + pair[1]
        heappush(heap, [lo[0] + hi[0]] + lo[1:] + hi[1:])
    return sorted(heappop(heap)[1:], key=lambda p: (len(p[-1]), p))
 
def assign_vp(w):
    symb2freq = collections.Counter(''.join(w))
    huff = encode(symb2freq)

    keys = defaultdict(lambda x: -5)
    for p in huff:
        keys[p[0]] = 5-len(p[1])
    return keys

words = ['%s<' % x for x in sys.argv[1:]]
assigned = {}
score = 0
print("Symbol\tScore\tRound")
for r in range(0, len(words)):
    keys = assign_vp(words[0:r+1])
    for k in keys:
        if k not in assigned:
            assigned[k] = keys[k]
            print("%s\t%+d\t%d" % (k, keys[k], r/2))
    wscore = sum([assigned[c] for c in words[r]])
    print("... %s scores %+d (avg %.2f/letter)" % (words[r], wscore, wscore/float(len(words[r]))))
    score += wscore

print("Final score: %d (avg %.2f/letter)" % (score, score/float(sum([len(w) for w in words]))))

