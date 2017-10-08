/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2017 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import { Id64 } from "@bentley/bentleyjs-core/lib/Id";
import { LRUMap } from "@bentley/bentleyjs-core/lib/LRUMap";
import { OpenMode } from "@bentley/bentleyjs-core/lib/BeSQLite";
import { AccessToken } from "@bentley/imodeljs-clients";
import { Element } from "../Element";
import { IModel, BriefcaseToken } from "../IModel";
import { IModelVersion } from "../IModelVersion";
import { Model } from "../Model";

// Imports for remoting to the backend implementation
import { IModelDbRemoting } from "../backend/IModelDbRemoting";

/** A connection to an iModel database hosted on the backend. */
export class IModelConnection extends IModel {
  public models: IModelConnectionModels;
  public elements: IModelConnectionElements;

  private constructor(briefcaseKey: BriefcaseToken) {
    super(briefcaseKey);
    this.models = new IModelConnectionModels(this);
    this.elements = new IModelConnectionElements(this);
  }

  /** Open an iModel from the iModelHub */
  public static async open(accessToken: AccessToken, iModelId: string, openMode: OpenMode = OpenMode.ReadWrite, version: IModelVersion = IModelVersion.latest()): Promise<IModelConnection> {
    const briefcaseKey = await IModelDbRemoting.open(accessToken, iModelId, openMode, version);
    return new IModelConnection(briefcaseKey);
  }

  /** Close this iModel */
  public async close(accessToken: AccessToken): Promise<void> {
    if (!this.briefcaseKey)
      return;
    await IModelDbRemoting.close(accessToken, this.briefcaseKey);
  }
}

/** The collection of models in an [[IModelConnection]]. */
export class IModelConnectionModels {
  private _iModel: IModelConnection;
  private _loaded: LRUMap<string, Model>;

  /** @hidden */
  public constructor(iModel: IModelConnection, max: number = 500) { this._iModel = iModel; this._loaded = new LRUMap<string, Model>(max); }

  /** The Id of the repository model. */
  public get repositoryModelId(): Id64 { return new Id64("0x1"); }

  /** Ask the backend for a batch of models given a list of model ids. */
  public async getModels(modelIds: Id64[]): Promise<Model[]> {
    return await IModelDbRemoting.getModels(this._iModel.briefcaseKey!, modelIds);
  }
}

/** The collection of elements in an [[IModelConnection]]. */
export class IModelConnectionElements {
  private _iModel: IModelConnection;
  private _loaded: LRUMap<string, Element>;

  /** get the map of loaded elements */
  public get loaded() { return this._loaded; }

  /** @hidden */
  public constructor(iModel: IModelConnection, maxElements: number = 2000) { this._iModel = iModel; this._loaded = new LRUMap<string, Element>(maxElements); }

  /** The Id of the root subject element. */
  public get rootSubjectId(): Id64 { return new Id64("0x1"); }

  /** Ask the backend for a batch of elements given a list of element ids. */
  public async getElements(elementIds: Id64[]): Promise<Element[]> {
    return await IModelDbRemoting.getElements(this._iModel.briefcaseKey!, elementIds);
  }
}
