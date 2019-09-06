/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Utilities */
import { IDisposable } from "@bentley/bentleyjs-core";

/**
 * A helper class to recursively save and restore scroll positions.
 * Usage:
 * ```ts
 * // scroll positions are saved when `ScrollPositionMaintainer` object is created
 * const maintainer = new ScrollPositionMaintainer(element);
 * // can do something with `element` here
 * // disposing the `maintainer` object restores scroll positions
 * maintainer.dispose();
 * ```
 * @alpha
 */
export class ScrollPositionMaintainer implements IDisposable {
  private _storage: Map<Element, number>;
  public constructor(el: Element) {
    this._storage = new Map();
    ScrollPositionMaintainer.saveScrollPositions([el], this._storage);
  }
  public dispose() { ScrollPositionMaintainer.restoreScrollPositions(this._storage); }
  private static saveScrollPositions(elems: Element[] | HTMLCollection, storage: Map<Element, number>) {
    for (const el of elems) {
      if (el.scrollTop)
        storage.set(el, el.scrollTop);
      if (el.children)
        this.saveScrollPositions(el.children, storage);
    }
  }
  private static restoreScrollPositions(storage: Map<Element, number>) {
    storage.forEach((scrollTop, el) => el.scrollTop = scrollTop);
  }
}
