/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Rendering
 */

import { assert, Id64String } from "@bentley/bentleyjs-core";
import {
  ClipPlane, ClipUtilities, ConvexClipPlaneSet, Geometry, GrowableXYZArray, LineString3d, Loop, Matrix3d, Plane3dByOriginAndUnitNormal, Point2d,
  Point3d, Range1d, Range3d, Ray3d, Transform, Vector2d, Vector3d, XAndY,
} from "@bentley/geometry-core";
import { ColorDef, Frustum, FrustumPlanes, LinePixels, SpatialClassificationProps, ViewFlags } from "@bentley/imodeljs-common";
import { IModelApp } from "./IModelApp";
import { CanvasDecoration } from "./render/CanvasDecoration";
import { Decorations } from "./render/Decorations";
import { GraphicBranch, GraphicBranchOptions } from "./render/GraphicBranch";
import { GraphicBuilder, GraphicType } from "./render/GraphicBuilder";
import { GraphicList, RenderGraphic } from "./render/RenderGraphic";
import { RenderPlanarClassifier } from "./render/RenderPlanarClassifier";
import { RenderTextureDrape } from "./render/RenderSystem";
import { RenderTarget } from "./render/RenderTarget";
import { Scene } from "./render/Scene";
import { Tile, TileGraphicType, TileLoadStatus, TileTreeReference } from "./tile/internal";
import { ViewingSpace } from "./ViewingSpace";
import { CachedDecoration, ScreenViewport, Viewport, ViewportDecorator } from "./Viewport";

const gridConstants = { minSeparation: 20, maxRefLines: 100, gridTransparency: 220, refTransparency: 150, planeTransparency: 225 };

/** Provides context for producing [[RenderGraphic]]s for drawing within a [[Viewport]].
 * @public
 */
export class RenderContext {
  /** ViewFlags extracted from the context's [[Viewport]]. */
  public readonly viewFlags: ViewFlags;
  /** The [[Viewport]] associated with this context. */
  public readonly viewport: Viewport;
  /** Frustum extracted from the context's [[Viewport]]. */
  public readonly frustum: Frustum;
  /** Frustum planes extracted from the context's [[Viewport]]. */
  public readonly frustumPlanes: FrustumPlanes;

  constructor(vp: Viewport, frustum?: Frustum) {
    this.viewport = vp;
    this.viewFlags = vp.viewFlags.clone(); // viewFlags can diverge from viewport after attachment
    this.frustum = frustum ? frustum : vp.getFrustum();
    this.frustumPlanes = new FrustumPlanes(this.frustum);
  }

  /** Given a point in world coordinates, determine approximately how many pixels it occupies on screen based on this context's frustum. */
  public getPixelSizeAtPoint(inPoint?: Point3d): number {
    return this.viewport.viewingSpace.getPixelSizeAtPoint(inPoint);
  }

  /** @internal */
  public get target(): RenderTarget { return this.viewport.target; }

  /** @internal */
  protected _createGraphicBuilder(type: GraphicType, transform?: Transform, id?: Id64String): GraphicBuilder {
    return this.target.createGraphicBuilder(type, this.viewport, transform, id);
  }

  /** Create a builder for creating a [[GraphicType.Scene]] [[RenderGraphic]] for rendering within this context's [[Viewport]].
   * @param transform the local-to-world transform in which the builder's geometry is to be defined.
   * @returns A builder for creating a [[GraphicType.Scene]] [[RenderGraphic]] for rendering within this context's [[Viewport]].
   */
  public createSceneGraphicBuilder(transform?: Transform): GraphicBuilder {
    return this._createGraphicBuilder(GraphicType.Scene, transform);
  }

  /** @internal */
  public createGraphicBranch(branch: GraphicBranch, location: Transform, opts?: GraphicBranchOptions): RenderGraphic {
    return this.target.renderSystem.createGraphicBranch(branch, location, opts);
  }

  /** Create a [[RenderGraphic]] which groups a set of graphics into a node in a scene graph, applying to each a transform and optional clip volume and symbology overrides.
   * @param branch Contains the group of graphics and the symbology overrides.
   * @param location the local-to-world transform applied to the grouped graphics.
   * @returns A RenderGraphic suitable for drawing the scene graph node within this context's [[Viewport]].
   * @see [[RenderSystem.createBranch]]
   */
  public createBranch(branch: GraphicBranch, location: Transform): RenderGraphic { return this.createGraphicBranch(branch, location); }

  /** Given the size of a logical pixel in meters, convert it to the size of a physical pixel in meters, if [[RenderSystem.dpiAwareLOD]] is `true`.
   * Used when computing LOD for graphics.
   * @internal
   */
  public adjustPixelSizeForLOD(cssPixelSize: number): number {
    return this.viewport.target.adjustPixelSizeForLOD(cssPixelSize);
  }
}

/** Provides context for an [[InteractiveTool]] to display decorations representing its current state.
 * @see [[InteractiveTool.onDynamicFrame]]
 * @public
 */
export class DynamicsContext extends RenderContext {
  private _dynamics?: GraphicList;

  /** Add a graphic to the list of dynamic graphics to be drawn in this context's [[Viewport]]. */
  public addGraphic(graphic: RenderGraphic) {
    if (undefined === this._dynamics)
      this._dynamics = [];
    this._dynamics.push(graphic);
  }

  /** @internal */
  public changeDynamics(): void {
    this.viewport.changeDynamics(this._dynamics);
  }
}

/** Provides context for a [[ViewportDecorator]] to add [[Decorations]] to be rendered within a [[Viewport]].
 * @public
 */
export class DecorateContext extends RenderContext {
  private _curCacheableDecorator?: ViewportDecorator;

  /** The [[ScreenViewport]] in which this context's [[Decorations]] will be drawn. */
  public get screenViewport(): ScreenViewport { return this.viewport as ScreenViewport; }
  /** @internal */
  constructor(vp: ScreenViewport, private readonly _decorations: Decorations) {
    super(vp);
  }

  /** Create a builder for creating a [[RenderGraphic]] of the specified type appropriate for rendering within this context's [[Viewport]].
   * @param type The type of builder to create.
   * @param transform the local-to-world transform in which the builder's geometry is to be defined.
   * @param id If the decoration is to be pickable, a unique identifier to associate with the resultant [[RenderGraphic]].
   * @returns A builder for creating a [[RenderGraphic]] of the specified type appropriate for rendering within this context's [[Viewport]].
   * @see [[IModelConnection.transientIds]] for obtaining an ID for a pickable decoration.
   */
  public createGraphicBuilder(type: GraphicType, transform?: Transform, id?: Id64String): GraphicBuilder {
    return this._createGraphicBuilder(type, transform, id);
  }

  /** @internal */
  public addFromDecorator(decorator: ViewportDecorator): void {
    assert(undefined === this._curCacheableDecorator);
    try {
      if (decorator.useCachedDecorations) {
        const cached = this.viewport.getCachedDecorations(decorator);
        if (cached) {
          this.restoreCache(cached);
          return;
        }

        this._curCacheableDecorator = decorator;
      }

      decorator.decorate(this);
    } finally {
      this._curCacheableDecorator = undefined;
    }
  }

  /** Restores decorations onto this context from the specified array of cached decorations. */
  private restoreCache(cachedDecorations: CachedDecoration[]) {
    cachedDecorations.forEach((cachedDecoration) => {
      switch (cachedDecoration.type) {
        case "graphic":
          this.addDecoration(cachedDecoration.graphicType, cachedDecoration.graphicOwner);
          break;
        case "canvas":
          this.addCanvasDecoration(cachedDecoration.canvasDecoration, cachedDecoration.atFront);
          break;
        case "html":
          this.addHtmlDecoration(cachedDecoration.htmlElement);
          break;
      }
    });
  }

  private _appendToCache(decoration: CachedDecoration) {
    assert(undefined !== this._curCacheableDecorator);
    this.viewport.addCachedDecoration(this._curCacheableDecorator, decoration);
  }

  /** Calls [[GraphicBuilder.finish]] on the supplied builder to obtain a [[RenderGraphic]], then adds the graphic to the appropriate list of
   * [[Decorations]].
   * @param builder The builder from which to extract the graphic.
   * @note The builder should not be used after calling this method.
   */
  public addDecorationFromBuilder(builder: GraphicBuilder) {
    this.addDecoration(builder.type, builder.finish());
  }

  /** Adds a graphic to the set of [[Decorations]] to be drawn in this context's [[ScreenViewport]].
   * @param The type of the graphic, which determines to which list of decorations it is added.
   * @param decoration The decoration graphic to add.
   * @note The type must match the type with which the [[RenderGraphic]]'s [[GraphicBuilder]] was constructed.
   * @see [[DecorateContext.addDecorationFromBuilder]] for a more convenient API.
   */
  public addDecoration(type: GraphicType, decoration: RenderGraphic) {
    if (this._curCacheableDecorator) {
      const graphicOwner = this.target.renderSystem.createGraphicOwner(decoration);
      this._appendToCache({ type: "graphic", graphicOwner, graphicType: type });
      decoration = graphicOwner;
    }

    switch (type) {
      case GraphicType.Scene:
        if (undefined === this._decorations.normal)
          this._decorations.normal = [];
        this._decorations.normal.push(decoration);
        break;

      case GraphicType.WorldDecoration:
        if (!this._decorations.world)
          this._decorations.world = [];
        this._decorations.world.push(decoration);
        break;

      case GraphicType.WorldOverlay:
        if (!this._decorations.worldOverlay)
          this._decorations.worldOverlay = [];
        this._decorations.worldOverlay.push(decoration);
        break;

      case GraphicType.ViewOverlay:
        if (!this._decorations.viewOverlay)
          this._decorations.viewOverlay = [];
        this._decorations.viewOverlay.push(decoration);
        break;

      case GraphicType.ViewBackground:
        this.setViewBackground(decoration);
        break;
    }
  }

  /** Add a [[CanvasDecoration]] to be drawn in this context's [[ScreenViewport]]. */
  public addCanvasDecoration(decoration: CanvasDecoration, atFront = false) {
    if (this._curCacheableDecorator)
      this._appendToCache({ type: "canvas", canvasDecoration: decoration, atFront });

    if (undefined === this._decorations.canvasDecorations)
      this._decorations.canvasDecorations = [];

    const list = this._decorations.canvasDecorations;
    if (0 === list.length || true === atFront)
      list.push(decoration);
    else
      list.unshift(decoration);
  }

  /** Add an HTMLElement to be drawn as a decoration in this context's [[ScreenViewport]]. */
  public addHtmlDecoration(decoration: HTMLElement) {
    if (this._curCacheableDecorator)
      this._appendToCache({ type: "html", htmlElement: decoration });

    this.screenViewport.decorationDiv.appendChild(decoration);
  }

  private getClippedGridPlanePoints(vp: Viewport, plane: Plane3dByOriginAndUnitNormal, loopPt: Point3d): Point3d[] | undefined {
    const frust = vp.getFrustum();
    const geom = ClipUtilities.loopsOfConvexClipPlaneIntersectionWithRange(ConvexClipPlaneSet.createPlanes([ClipPlane.createPlane(plane)]), frust.toRange(), true, false, true);
    if (undefined === geom || 1 !== geom.length)
      return undefined;
    const loop = geom[0];
    if (!(loop instanceof Loop) || 1 !== loop.children.length)
      return undefined;
    const child = loop.getChild(0);
    if (!(child instanceof LineString3d))
      return undefined;

    const work = new GrowableXYZArray();
    const finalPoints = new GrowableXYZArray();
    const convexSet = frust.getRangePlanes(false, false, 0);
    convexSet.polygonClip(child.points, finalPoints, work);
    if (finalPoints.length < 4)
      return undefined;

    const shapePoints = finalPoints.getPoint3dArray();
    let closeIndex = 0;
    if (vp.isCameraOn) {
      let lastZ = 0.0;
      for (let i = 0; i < shapePoints.length; ++i) {
        vp.worldToView(shapePoints[i], loopPt);
        if (i === 0 || loopPt.z > lastZ) {
          lastZ = loopPt.z;
          closeIndex = i;
        }
      }
    }
    loopPt.setFrom(shapePoints[closeIndex]);
    return shapePoints;
  }

  private getCurrentGridRefSeparation(lastPt: Point3d, thisPt0: Point3d, thisPt1: Point3d, thisPt: Point3d, thisRay: Ray3d, planeX: Plane3dByOriginAndUnitNormal, planeY: Plane3dByOriginAndUnitNormal) {
    thisRay.getOriginRef().setFrom(thisPt0);
    thisRay.getDirectionRef().setStartEnd(thisPt0, thisPt1); thisRay.getDirectionRef().normalizeInPlace();
    planeX.getOriginRef().setFrom(lastPt);
    planeY.getOriginRef().setFrom(lastPt);
    const dotX = Math.abs(planeX.getNormalRef().dotProduct(thisRay.getDirectionRef()));
    const dotY = Math.abs(planeY.getNormalRef().dotProduct(thisRay.getDirectionRef()));
    return (undefined !== thisRay.intersectionWithPlane(dotX > dotY ? planeX : planeY, thisPt)) ? lastPt.distance(thisPt) : 0.0;
  }

  /** @internal */
  public drawStandardGrid(gridOrigin: Point3d, rMatrix: Matrix3d, spacing: XAndY, gridsPerRef: number, _isoGrid: boolean = false, _fixedRepetitions?: Point2d): void {
    const vp = this.viewport;
    const eyePoint = vp.worldToViewMap.transform1.columnZ();
    const eyeDir = Vector3d.createFrom(eyePoint);
    const aa = Geometry.conditionalDivideFraction(1, eyePoint.w);
    if (aa !== undefined) {
      const xyzEye = eyeDir.scale(aa);
      eyeDir.setFrom(gridOrigin.vectorTo(xyzEye));
    }
    const normResult = eyeDir.normalize(eyeDir);
    if (!normResult)
      return;
    const zVec = rMatrix.rowZ();
    const eyeDot = eyeDir.dotProduct(zVec);
    if (!vp.isCameraOn && Math.abs(eyeDot) < 0.005)
      return;

    const plane = Plane3dByOriginAndUnitNormal.create(gridOrigin, zVec);
    if (undefined === plane)
      return;

    const loopPt = Point3d.createZero();
    const shapePoints = this.getClippedGridPlanePoints(vp, plane, loopPt);
    if (undefined === shapePoints)
      return;

    const meterPerPixel = vp.getPixelSizeAtPoint(loopPt);
    const refScale = (0 === gridsPerRef) ? 1.0 : gridsPerRef;
    const refSpacing = Vector2d.create(spacing.x, spacing.y).scale(refScale);
    const drawRefLines = !((refSpacing.x / meterPerPixel) < gridConstants.minSeparation || (refSpacing.y / meterPerPixel) < gridConstants.minSeparation);

    const viewZ = vp.rotation.getRow(2);
    const gridOffset = Point3d.create(viewZ.x * meterPerPixel, viewZ.y * meterPerPixel, viewZ.z * meterPerPixel); // Avoid z fighting with coincident geometry
    const builder = this.createGraphicBuilder(GraphicType.WorldDecoration, Transform.createTranslation(gridOffset));
    const color = vp.getContrastToBackgroundColor();
    const planeColor = (eyeDot < 0.0 ? ColorDef.red : color).withTransparency(gridConstants.planeTransparency);

    builder.setBlankingFill(planeColor);
    builder.addShape(shapePoints);

    if (drawRefLines) {
      const invMatrix = rMatrix.inverse();
      const transform = Transform.createRefs(gridOrigin, invMatrix!);
      const localRange = Range3d.createInverseTransformedArray(transform, shapePoints);

      let minX = Math.floor(localRange.low.x / refSpacing.x);
      let maxX = Math.ceil(localRange.high.x / refSpacing.x);
      let minY = Math.floor(localRange.low.y / refSpacing.y);
      let maxY = Math.ceil(localRange.high.y / refSpacing.y);

      const nRefRepetitionsX = (maxY - minY);
      const nRefRepetitionsY = (maxX - minX);

      minX *= refSpacing.x; maxX *= refSpacing.x;
      minY *= refSpacing.y; maxY *= refSpacing.y;

      let nGridRepetitionsX = nRefRepetitionsX;
      let nGridRepetitionsY = nRefRepetitionsY;

      const dirPoints: Point3d[] = [Point3d.create(minX, minY), Point3d.create(minX, minY + refSpacing.y), Point3d.create(minX + refSpacing.x, minY)];
      transform.multiplyPoint3dArrayInPlace(dirPoints);

      const xDir = Vector3d.createStartEnd(dirPoints[0], dirPoints[1]); xDir.normalizeInPlace();
      const yDir = Vector3d.createStartEnd(dirPoints[0], dirPoints[2]); yDir.normalizeInPlace();
      const dotX = xDir.dotProduct(viewZ);
      const dotY = yDir.dotProduct(viewZ);
      const unambiguousX = Math.abs(dotX) > 0.25;
      const unambiguousY = Math.abs(dotY) > 0.25;
      const reverseX = dotX > 0.0;
      const reverseY = dotY > 0.0;
      const refStepX = reverseY ? -refSpacing.x : refSpacing.x;
      const refStepY = reverseX ? -refSpacing.y : refSpacing.y;
      const fadeRefSteps = 8;
      const fadeRefTransparencyStep = (255 - gridConstants.refTransparency) / (fadeRefSteps + 2);

      let lastDist = 0.0;
      const lastPt = Point3d.createZero();
      const planeX = Plane3dByOriginAndUnitNormal.create(lastPt, Vector3d.unitX())!;
      const planeY = Plane3dByOriginAndUnitNormal.create(lastPt, Vector3d.unitY())!;
      const thisPt = Point3d.create();
      const thisPt0 = Point3d.create();
      const thisPt1 = Point3d.create();
      const thisRay = Ray3d.createZero();

      let refColor = color.withTransparency(gridConstants.refTransparency);
      const linePat = eyeDot < 0.0 ? LinePixels.Code2 : LinePixels.Solid;

      const drawRefX = (nRefRepetitionsX < gridConstants.maxRefLines || (vp.isCameraOn && unambiguousX));
      const drawRefY = (nRefRepetitionsY < gridConstants.maxRefLines || (vp.isCameraOn && unambiguousY));
      const drawGridLines = drawRefX && drawRefY && (gridsPerRef > 1 && !((spacing.x / meterPerPixel) < gridConstants.minSeparation || (spacing.y / meterPerPixel) < gridConstants.minSeparation));

      if (drawRefX) {
        builder.setSymbology(refColor, planeColor, 1, linePat);

        for (let xRef = 0, refY = reverseX ? maxY : minY, doFadeX = false, xFade = 0; xRef <= nRefRepetitionsX && xFade < fadeRefSteps; ++xRef, refY += refStepY) {
          const linePoints: Point3d[] = [Point3d.create(minX, refY), Point3d.create(maxX, refY)];
          transform.multiplyPoint3dArrayInPlace(linePoints);

          vp.worldToView(linePoints[0], thisPt0); thisPt0.z = 0.0;
          vp.worldToView(linePoints[1], thisPt1); thisPt1.z = 0.0;

          if (doFadeX) {
            refColor = refColor.withTransparency(gridConstants.refTransparency + (fadeRefTransparencyStep * ++xFade));
            builder.setSymbology(refColor, planeColor, 1, linePat);
          } else if (xRef > 0 && nRefRepetitionsX > 10) {
            if (xRef > gridConstants.maxRefLines) {
              doFadeX = true;
            } else if (unambiguousX && vp.isCameraOn) {
              const thisDist = this.getCurrentGridRefSeparation(lastPt, thisPt0, thisPt1, thisPt, thisRay, planeX, planeY);
              if (thisDist < gridConstants.minSeparation)
                doFadeX = (vp.isCameraOn ? (xRef > 1 && thisDist < lastDist) : true);
              lastDist = thisDist;
            }
            if (doFadeX) nGridRepetitionsX = xRef;
          }

          thisPt0.interpolate(0.5, thisPt1, lastPt);
          builder.addLineString(linePoints);
        }
      }

      if (drawRefY) {
        refColor = refColor.withTransparency(gridConstants.refTransparency);
        builder.setSymbology(refColor, planeColor, 1, linePat);

        for (let yRef = 0, refX = reverseY ? maxX : minX, doFadeY = false, yFade = 0; yRef <= nRefRepetitionsY && yFade < fadeRefSteps; ++yRef, refX += refStepX) {
          const linePoints: Point3d[] = [Point3d.create(refX, minY), Point3d.create(refX, maxY)];
          transform.multiplyPoint3dArrayInPlace(linePoints);

          vp.worldToView(linePoints[0], thisPt0); thisPt0.z = 0.0;
          vp.worldToView(linePoints[1], thisPt1); thisPt1.z = 0.0;

          if (doFadeY) {
            refColor = refColor.withTransparency(gridConstants.refTransparency + (fadeRefTransparencyStep * ++yFade));
            builder.setSymbology(refColor, planeColor, 1, linePat);
          } else if (yRef > 0 && nRefRepetitionsY > 10) {
            if (yRef > gridConstants.maxRefLines) {
              doFadeY = true;
            } else if (unambiguousY && vp.isCameraOn) {
              const thisDist = this.getCurrentGridRefSeparation(lastPt, thisPt0, thisPt1, thisPt, thisRay, planeX, planeY);
              if (thisDist < gridConstants.minSeparation)
                doFadeY = (vp.isCameraOn ? (yRef > 1 && thisDist < lastDist) : true);
              lastDist = thisDist;
            }
            if (doFadeY) nGridRepetitionsY = yRef;
          }

          thisPt0.interpolate(0.5, thisPt1, lastPt);
          builder.addLineString(linePoints);
        }
      }

      if (drawGridLines) {
        const gridStepX = refStepX / gridsPerRef;
        const gridStepY = refStepY / gridsPerRef;
        let gridColor = color;
        const fadeGridTransparencyStep = (255 - gridConstants.gridTransparency) / (gridsPerRef + 2);

        if (nGridRepetitionsX > 1) {
          gridColor = gridColor.withTransparency(gridConstants.gridTransparency);
          builder.setSymbology(gridColor, planeColor, 1);

          for (let xRef = 0, refY = reverseX ? maxY : minY; xRef < nGridRepetitionsX; ++xRef, refY += refStepY) {
            const doFadeX = (nGridRepetitionsX < nRefRepetitionsX && (xRef === nGridRepetitionsX - 1));
            for (let yGrid = 1, gridY = refY + gridStepY; yGrid < gridsPerRef; ++yGrid, gridY += gridStepY) {
              const gridPoints: Point3d[] = [Point3d.create(minX, gridY), Point3d.create(maxX, gridY)];
              transform.multiplyPoint3dArrayInPlace(gridPoints);
              if (doFadeX) {
                gridColor = gridColor.withTransparency(gridConstants.gridTransparency + (fadeGridTransparencyStep * yGrid));
                builder.setSymbology(gridColor, planeColor, 1);
              }
              builder.addLineString(gridPoints);
            }
          }
        }

        if (nGridRepetitionsY > 1) {
          gridColor = gridColor.withTransparency(gridConstants.gridTransparency);
          builder.setSymbology(gridColor, planeColor, 1);

          for (let yRef = 0, refX = reverseY ? maxX : minX; yRef < nGridRepetitionsY; ++yRef, refX += refStepX) {
            const doFadeY = (nGridRepetitionsY < nRefRepetitionsY && (yRef === nGridRepetitionsY - 1));
            for (let xGrid = 1, gridX = refX + gridStepX; xGrid < gridsPerRef; ++xGrid, gridX += gridStepX) {
              const gridPoints: Point3d[] = [Point3d.create(gridX, minY), Point3d.create(gridX, maxY)];
              transform.multiplyPoint3dArrayInPlace(gridPoints);
              if (doFadeY) {
                gridColor = gridColor.withTransparency(gridConstants.gridTransparency + (fadeGridTransparencyStep * xGrid));
                builder.setSymbology(gridColor, planeColor, 1);
              }
              builder.addLineString(gridPoints);
            }
          }
        }
      }
    }

    this.addDecorationFromBuilder(builder);
  }

  /** Display skyBox graphic that encompasses entire scene and rotates with camera.
   * @see [[RenderSystem.createSkyBox]].
   */
  public setSkyBox(graphic: RenderGraphic) {
    this._decorations.skyBox = graphic;
  }

  /** Set the graphic to be displayed behind all other geometry as the background of this context's [[ScreenViewport]]. */
  public setViewBackground(graphic: RenderGraphic) {
    this._decorations.viewBackground = graphic;
  }
}

/** Context used to create the scene for a [[Viewport]]. The scene consists of a set of [[RenderGraphic]]s produced by the
 * [[TileTree]]s visible within the viewport. Creating the scene may result in the enqueueing of requests for [[Tile]]s which
 * should be displayed in the viewport but are not yet loaded.
 * @beta
 */
export class SceneContext extends RenderContext {
  private _missingChildTiles = false;
  /** The graphics comprising the scene. */
  public readonly scene = new Scene();
  /** @internal */
  public readonly missingTiles = new Set<Tile>();
  /** @internal */
  public markChildrenLoading(): void {
    this._missingChildTiles = true;
  }
  /** @internal */
  public get hasMissingTiles(): boolean {
    return this._missingChildTiles || this.missingTiles.size > 0;
  }

  /** @internal */
  public readonly modelClassifiers = new Map<Id64String, Id64String>();    // Model id to classifier model Id.
  private _viewingSpace?: ViewingSpace;
  private _graphicType: TileGraphicType = TileGraphicType.Scene;

  public constructor(vp: Viewport, frustum?: Frustum) {
    super(vp, frustum);
  }

  public get viewingSpace(): ViewingSpace {
    return undefined !== this._viewingSpace ? this._viewingSpace : this.viewport.viewingSpace;
  }

  /** @internal */
  public get graphicType() { return this._graphicType; }

  /** @internal */
  public outputGraphic(graphic: RenderGraphic): void {
    switch (this._graphicType) {
      case TileGraphicType.BackgroundMap:
        this.backgroundGraphics.push(graphic);
        break;
      case TileGraphicType.Overlay:
        this.overlayGraphics.push(graphic);
        break;
      default:
        this.graphics.push(graphic);
        break;
    }
  }

  /** Indicate that the specified tile is desired for the scene but is not yet ready. A request to load its contents will later be enqueued. */
  public insertMissingTile(tile: Tile): void {
    switch (tile.loadStatus) {
      case TileLoadStatus.NotLoaded:
      case TileLoadStatus.Queued:
      case TileLoadStatus.Loading:
        this.missingTiles.add(tile);
        break;
    }
  }

  /** @internal */
  public requestMissingTiles(): void {
    IModelApp.tileAdmin.requestTiles(this.viewport, this.missingTiles);
  }

  /** @internal */
  public addPlanarClassifier(props: SpatialClassificationProps.Classifier, tileTree: TileTreeReference, classifiedTree: TileTreeReference): RenderPlanarClassifier | undefined {
    // Have we already seen this classifier before?
    const id = props.modelId;
    let classifier = this.planarClassifiers.get(id);
    if (undefined !== classifier)
      return classifier;

    // Target may have the classifier from a previous frame; if not we must create one.
    classifier = this.viewport.target.getPlanarClassifier(id);
    if (undefined === classifier)
      classifier = this.viewport.target.createPlanarClassifier(props);

    // Either way, we need to collect the graphics to draw for this frame, and record that we did so.
    if (undefined !== classifier) {
      this.planarClassifiers.set(id, classifier);
      classifier.collectGraphics(this, classifiedTree, tileTree);
    }

    return classifier;
  }

  /** @internal */
  public getPlanarClassifierForModel(modelId: Id64String) {
    const classifierId = this.modelClassifiers.get(modelId);
    return undefined === classifierId ? undefined : this.planarClassifiers.get(classifierId);
  }

  /** @internal */
  public addBackgroundDrapedModel(drapedTreeRef: TileTreeReference, _heightRange: Range1d | undefined): RenderTextureDrape | undefined {
    const drapedTree = drapedTreeRef.treeOwner.tileTree;
    if (undefined === drapedTree)
      return undefined;

    const id = drapedTree.modelId;
    let drape = this.getTextureDrapeForModel(id);
    if (undefined !== drape)
      return drape;

    drape = this.viewport.target.getTextureDrape(id);
    if (undefined === drape)
      drape = this.viewport.target.renderSystem.createBackgroundMapDrape(drapedTreeRef, this.viewport.displayStyle.backgroundDrapeMap);

    if (undefined !== drape)
      this.textureDrapes.set(id, drape);

    return drape;
  }

  /** @internal */
  public getTextureDrapeForModel(modelId: Id64String) {
    return this.textureDrapes.get(modelId);
  }

  /** @internal */
  public withGraphicType(type: TileGraphicType, func: () => void): void {
    const prevType = this._graphicType;
    this._graphicType = type;

    func();

    this._graphicType = prevType;
  }

  /** @internal */
  public get graphics() { return this.scene.foreground; }
  /** @internal */
  public get backgroundGraphics() { return this.scene.background; }
  /** @internal */
  public get overlayGraphics() { return this.scene.overlay; }
  /** @internal */
  public get planarClassifiers() { return this.scene.planarClassifiers; }
  /** @internal */
  public get textureDrapes() { return this.scene.textureDrapes; }

  /** @internal */
  public setVolumeClassifier(classifier: SpatialClassificationProps.Classifier, modelId: Id64String): void {
    this.scene.volumeClassifier = { classifier, modelId };
  }
}
