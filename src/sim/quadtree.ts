/**
 * Generic 2-D point quadtree for neighbor queries. Pooled nodes — no
 * allocations in steady state once the pool is warm. This is the
 * foundation for future Barnes-Hut aggregation (each node can carry a
 * mean position + count) when dense clusters need O(log n) chase queries.
 */

const MAX_PER_LEAF = 8;
const MAX_DEPTH = 9;

interface QuadItem {
  pos: { x: number; y: number };
}

class QuadNode<T extends QuadItem> {
  x0 = 0;
  y0 = 0;
  x1 = 0;
  y1 = 0;
  items: T[] = [];
  c0: QuadNode<T> | null = null;
  c1: QuadNode<T> | null = null;
  c2: QuadNode<T> | null = null;
  c3: QuadNode<T> | null = null;

  reset(x0: number, y0: number, x1: number, y1: number): void {
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
    this.items.length = 0;
    this.c0 = null;
    this.c1 = null;
    this.c2 = null;
    this.c3 = null;
  }
}

export class QuadTree<T extends QuadItem> {
  private nodes: QuadNode<T>[] = [];
  private nodeIdx = 0;
  private bounds: number;
  root: QuadNode<T>;

  constructor(bounds: number) {
    this.bounds = bounds;
    for (let i = 0; i < 128; i++) this.nodes.push(new QuadNode<T>());
    this.root = this.allocNode();
    this.root.reset(-bounds, -bounds, bounds, bounds);
  }

  private allocNode(): QuadNode<T> {
    if (this.nodeIdx >= this.nodes.length) {
      this.nodes.push(new QuadNode<T>());
    }
    return this.nodes[this.nodeIdx++];
  }

  rebuild(items: T[]): void {
    this.nodeIdx = 0;
    this.root = this.allocNode();
    this.root.reset(-this.bounds, -this.bounds, this.bounds, this.bounds);
    for (let i = 0; i < items.length; i++) {
      this.insertItem(this.root, items[i], 0);
    }
  }

  private insertItem(node: QuadNode<T>, it: T, depth: number): void {
    // Descend to the appropriate leaf.
    while (node.c0 !== null) {
      const mx = (node.x0 + node.x1) * 0.5;
      const my = (node.y0 + node.y1) * 0.5;
      if (it.pos.x < mx) {
        node = it.pos.y < my ? node.c0 : (node.c2 as QuadNode<T>);
      } else {
        node = it.pos.y < my ? (node.c1 as QuadNode<T>) : (node.c3 as QuadNode<T>);
      }
      depth++;
    }
    node.items.push(it);

    // Split if leaf is over capacity (and we still have depth).
    if (node.items.length > MAX_PER_LEAF && depth < MAX_DEPTH) {
      const mx = (node.x0 + node.x1) * 0.5;
      const my = (node.y0 + node.y1) * 0.5;
      const c0 = this.allocNode(); c0.reset(node.x0, node.y0, mx, my);
      const c1 = this.allocNode(); c1.reset(mx, node.y0, node.x1, my);
      const c2 = this.allocNode(); c2.reset(node.x0, my, mx, node.y1);
      const c3 = this.allocNode(); c3.reset(mx, my, node.x1, node.y1);
      node.c0 = c0;
      node.c1 = c1;
      node.c2 = c2;
      node.c3 = c3;
      const items = node.items;
      node.items = [];
      // Re-insert through the parent so each item recursively settles.
      for (let i = 0; i < items.length; i++) {
        this.insertItem(node, items[i], depth);
      }
    }
  }

  /** Append items whose pos falls inside the AABB to `out`. */
  queryAABB(qx0: number, qy0: number, qx1: number, qy1: number, out: T[]): void {
    this.queryNode(this.root, qx0, qy0, qx1, qy1, out);
  }

  private queryNode(
    node: QuadNode<T>,
    qx0: number,
    qy0: number,
    qx1: number,
    qy1: number,
    out: T[],
  ): void {
    if (qx1 < node.x0 || qx0 > node.x1 || qy1 < node.y0 || qy0 > node.y1) return;
    if (node.c0 === null) {
      const items = node.items;
      for (let i = 0, n = items.length; i < n; i++) out.push(items[i]);
      return;
    }
    this.queryNode(node.c0, qx0, qy0, qx1, qy1, out);
    this.queryNode(node.c1 as QuadNode<T>, qx0, qy0, qx1, qy1, out);
    this.queryNode(node.c2 as QuadNode<T>, qx0, qy0, qx1, qy1, out);
    this.queryNode(node.c3 as QuadNode<T>, qx0, qy0, qx1, qy1, out);
  }
}
