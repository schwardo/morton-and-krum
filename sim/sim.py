#!/usr/bin/env python

import queue
from collections import defaultdict

ROWS = [
  [ 1,  1,  2,  2,  2,  2,  2,  2,  3],  # Easy
  [ 1,  1,  1,  1,  2,  2,  2,  3,  3],
    
  [ 0,  0,  0,  0,  2,  2,  3,  3,  3],  # Medium
  [-1, -1, -1, -1, -1, -1,  0,  4,  4],
    
  [-2, -2, -1,  0,  1,  2,  2,  3,  4],  # Hard
  [-2, -2, -2, -2, -1, -1,  0,  0,  5],
    
#  [ 0,  0,  0,  0,  1,  1, 2, 3, 4],
#  [-1, -1, -1, -1,  1,  2, 2, 3, 4],
#  [-1, -1, 0, 0, 0, 0, 0, 3, 3],
#  [-1, -1, 0, 0, 0, 2, 2, 3, 4],
#  [-2 ,-2, -1, -1, -1, 0, 0, 4, 4],
#  [-1, -1, -1, -1, -1, -1, -1, -1, 5],
]

FREQ = [
    (8.167, 'a'), (1.492, 'b'), (2.782, 'c'), (4.253, 'd'),
    (12.702, 'e'),(2.228, 'f'), (2.015, 'g'), (6.094, 'h'),
    (6.966, 'i'), (0.153, 'j'), (0.747, 'k'), (4.025, 'l'),
    (2.406, 'm'), (6.749, 'n'), (7.507, 'o'), (1.929, 'p'), 
    (0.095, 'q'), (5.987, 'r'), (6.327, 's'), (9.056, 't'), 
    (2.758, 'u'), (1.037, 'v'), (2.365, 'w'), (0.150, 'x'),
    (1.974, 'y'), (0.074, 'z'), (1.000, '<'), (0.300, '_') ]

class HuffmanNode(object):
    def __init__(self, left=None, right=None, root=None):
        self.left = left
        self.right = right
        self.root = root     # Why?  Not needed for anything.
    def children(self):
        return((self.left, self.right))

def create_tree(frequencies):
    p = queue.PriorityQueue()
    for value in frequencies:    # 1. Create a leaf node for each symbol
        p.put(value)             #    and add it to the priority queue
    while p.qsize() > 1:         # 2. While there is more than one node
        l, r = p.get(), p.get()  # 2a. remove two highest nodes
        node = HuffmanNode(l, r) # 2b. create internal node with children
        p.put((l[0]+r[0], node)) # 2c. add new node to queue      
    return p.get()               # 3. tree is complete - return root node

def walk_tree(node, prefix="", code={}):
    if isinstance(node[1].left[1], HuffmanNode):
        walk_tree(node[1].left,prefix+"0", code)
    else:
        code[node[1].left[1]]=prefix+"0"
    if isinstance(node[1].right[1],HuffmanNode):
        walk_tree(node[1].right,prefix+"1", code)
    else:
        code[node[1].right[1]]=prefix+"1"
    return(code)

def calc_hist(values):
  hist = defaultdict(int)
  for v in values:
      hist[v] += 1
  return format_hist(hist)

def format_hist(hist):
  out = []
#  for i in range(min(hist.keys()), max(hist.keys())):
  for i in range(-2, 5):
#      out.append('%d=%d' % (i, hist[i]))
      out.append(hist[i])
  return out

def main():
  node = create_tree(FREQ)
  print(node)

  hist = defaultdict(int)
  
  code = walk_tree(node)
  for i in sorted(FREQ, reverse=True):
    print(i[1], '{:6.2f}'.format(i[0]), code[i[1]])
    hist[7-len(code[i[1]])] += 1

  print('Target: %r' % format_hist(hist))

  print()
  for i, row1 in enumerate(ROWS):
    for j, row2 in enumerate(ROWS):
      for k, row3 in enumerate(ROWS):
          print('... %d-%d-%d: %r' % (i, j, k, calc_hist(row1 + row2 + row3)))

main()
