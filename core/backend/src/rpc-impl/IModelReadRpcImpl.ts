/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module RpcInterface
 */

import { assert, ClientRequestContext, Id64, Id64String, IModelStatus, Logger, OpenMode } from "@bentley/bentleyjs-core";
import { Range3d, Range3dProps } from "@bentley/geometry-core";
import { AuthorizedClientRequestContext } from "@bentley/imodeljs-clients";
import {
  ElementProps,
  EntityMetaData,
  EntityQueryParams,
  GeoCoordinatesResponseProps,
  GeometrySummaryRequestProps,
  ImageSourceFormat,
  IModel,
  IModelConnectionProps,
  IModelCoordinatesResponseProps,
  IModelReadRpcInterface,
  IModelRpcProps,
  IModelVersion,
  MassPropertiesRequestProps,
  MassPropertiesResponseProps,
  ModelProps,
  QueryLimit,
  QueryPriority,
  QueryQuota,
  QueryResponse,
  RpcInterface,
  RpcManager,
  SnapRequestProps,
  SnapResponseProps,
  ViewStateProps,
} from "@bentley/imodeljs-common";
import { BackendLoggerCategory } from "../BackendLoggerCategory";
import { KeepBriefcase } from "../BriefcaseManager";
import { SpatialCategory } from "../Category";
import { generateGeometrySummaries } from "../GeometrySummary";
import { BriefcaseDb, IModelDb, OpenParams } from "../IModelDb";
import { DictionaryModel } from "../Model";

const loggerCategory: string = BackendLoggerCategory.IModelDb;

/** The backend implementation of IModelReadRpcInterface.
 * @internal
 */
export class IModelReadRpcImpl extends RpcInterface implements IModelReadRpcInterface {

  public static register() { RpcManager.registerImpl(IModelReadRpcInterface, IModelReadRpcImpl); }

  public async openForRead(tokenProps: IModelRpcProps): Promise<IModelConnectionProps> {
    const requestContext = ClientRequestContext.current as AuthorizedClientRequestContext;
    const openParams: OpenParams = OpenParams.fixedVersion();
    openParams.timeout = 1000; // 1 second
    const iModelVersion = IModelVersion.asOfChangeSet(tokenProps.changeSetId!);
    const db = await BriefcaseDb.open(requestContext, tokenProps.contextId!, tokenProps.iModelId!, openParams, iModelVersion);
    return db.toJSON();
  }

  public async close(tokenProps: IModelRpcProps): Promise<boolean> {
    const requestContext = ClientRequestContext.current as AuthorizedClientRequestContext;
    if (OpenMode.Readonly === tokenProps.openMode) {
      return Promise.resolve(true); // Close is a no-op for ReadOnly connections.
    }
    await BriefcaseDb.findByKey(tokenProps.key).close(requestContext, KeepBriefcase.No);
    return Promise.resolve(true);
  }

  public async queryRows(tokenProps: IModelRpcProps, ecsql: string, bindings?: any[] | object, limit?: QueryLimit, quota?: QueryQuota, priority?: QueryPriority): Promise<QueryResponse> {
    const iModelDb: IModelDb = IModelDb.findByKey(tokenProps.key);
    return iModelDb.queryRows(ecsql, bindings, limit, quota, priority);
  }

  public async queryModelRanges(tokenProps: IModelRpcProps, modelIdsList: Id64String[]): Promise<Range3dProps[]> {
    const modelIds = new Set(modelIdsList);
    const iModelDb: IModelDb = IModelDb.findByKey(tokenProps.key);
    const ranges: Range3dProps[] = [];
    for (const id of modelIds) {
      const val = iModelDb.nativeDb.queryModelExtents(JSON.stringify({ id: id.toString() }));
      if (val.error) {
        if (val.error.status === IModelStatus.NoGeometry) { // if there was no geometry, just return null range
          ranges.push(new Range3d());
          continue;
        }

        if (modelIds.size === 1)
          throw val.error; // if they're asking for more than one model, don't throw on error.
      }
      const range = JSON.parse(val.result!);
      if (range.modelExtents) {
        ranges.push(range.modelExtents);
      }
    }
    return ranges;
  }

  public async getModelProps(tokenProps: IModelRpcProps, modelIdsList: Id64String[]): Promise<ModelProps[]> {
    const modelIds = new Set(modelIdsList);
    const iModelDb: IModelDb = IModelDb.findByKey(tokenProps.key);
    const modelJsonArray: ModelProps[] = [];
    for (const id of modelIds) {
      try {
        // TODO: Change iModelDbModels.getModelJson to return a ModelProps object, rather than a string.
        const modelProps: any = JSON.parse(iModelDb.models.getModelJson(JSON.stringify({ id })));
        assert("modeledElement" in modelProps, "iModelDb.models.getModelJson must return a ModelProps object");
        modelJsonArray.push(modelProps);
      } catch (error) {
        if (modelIds.size === 1)
          throw error; // if they're asking for more than one model, don't throw on error.
      }
    }
    return modelJsonArray;
  }

  public async queryModelProps(tokenProps: IModelRpcProps, params: EntityQueryParams): Promise<ModelProps[]> {
    const ids = await this.queryEntityIds(tokenProps, params);
    return this.getModelProps(tokenProps, [...ids]);
  }

  public async getElementProps(tokenProps: IModelRpcProps, elementIdsList: Id64String[]): Promise<ElementProps[]> {
    const elementIds = new Set(elementIdsList);
    const iModelDb: IModelDb = IModelDb.findByKey(tokenProps.key);
    const elementProps: ElementProps[] = [];
    for (const id of elementIds) {
      try {
        elementProps.push(iModelDb.elements.getElementJson(JSON.stringify({ id })));
      } catch (error) {
        if (elementIds.size === 1)
          throw error; // if they're asking for more than one element, don't throw on error.
      }
    }
    return elementProps;
  }

  public async getGeometrySummary(tokenProps: IModelRpcProps, request: GeometrySummaryRequestProps): Promise<string> {
    const iModel = IModelDb.findByKey(tokenProps.key);
    return generateGeometrySummaries(request, iModel);
  }

  public async queryElementProps(tokenProps: IModelRpcProps, params: EntityQueryParams): Promise<ElementProps[]> {
    const ids = await this.queryEntityIds(tokenProps, params);
    const res = this.getElementProps(tokenProps, [...ids]);
    return res;
  }

  public async queryEntityIds(tokenProps: IModelRpcProps, params: EntityQueryParams): Promise<Id64String[]> {
    const res = IModelDb.findByKey(tokenProps.key).queryEntityIds(params);
    return [...res];
  }

  public async getClassHierarchy(tokenProps: IModelRpcProps, classFullName: string): Promise<string[]> {
    const iModelDb: IModelDb = IModelDb.findByKey(tokenProps.key);
    const classArray: string[] = [];
    while (true) {
      const classMetaData: EntityMetaData = iModelDb.getMetaData(classFullName);
      classArray.push(classFullName);
      if (!classMetaData.baseClasses || classMetaData.baseClasses.length === 0)
        break;

      classFullName = classMetaData.baseClasses[0];
    }
    return classArray;
  }

  public async getAllCodeSpecs(tokenProps: IModelRpcProps): Promise<any[]> {
    const codeSpecs: any[] = [];
    IModelDb.findByKey(tokenProps.key).withPreparedStatement("SELECT ECInstanceId AS id, name, jsonProperties FROM BisCore.CodeSpec", (statement) => {
      for (const row of statement)
        codeSpecs.push({ id: row.id, name: row.name, jsonProperties: JSON.parse(row.jsonProperties) });
    });
    Logger.logTrace(loggerCategory, "IModelDbRemoting.getAllCodeSpecs", () => ({ numCodeSpecs: codeSpecs.length }));
    return codeSpecs;
  }

  public async getViewStateData(tokenProps: IModelRpcProps, viewDefinitionId: string): Promise<ViewStateProps> {
    return IModelDb.findByKey(tokenProps.key).views.getViewStateData(viewDefinitionId);
  }

  public async readFontJson(tokenProps: IModelRpcProps): Promise<any> {
    return IModelDb.findByKey(tokenProps.key).readFontJson();
  }

  public async requestSnap(tokenProps: IModelRpcProps, sessionId: string, props: SnapRequestProps): Promise<SnapResponseProps> {
    const requestContext = ClientRequestContext.current;
    return IModelDb.findByKey(tokenProps.key).requestSnap(requestContext, sessionId, props);
  }

  public async cancelSnap(tokenProps: IModelRpcProps, sessionId: string): Promise<void> {
    return IModelDb.findByKey(tokenProps.key).cancelSnap(sessionId);
  }

  public async getMassProperties(tokenProps: IModelRpcProps, props: MassPropertiesRequestProps): Promise<MassPropertiesResponseProps> {
    const requestContext = ClientRequestContext.current;
    return IModelDb.findByKey(tokenProps.key).getMassProperties(requestContext, props);
  }

  public async getToolTipMessage(tokenProps: IModelRpcProps, id: string): Promise<string[]> {
    const el = IModelDb.findByKey(tokenProps.key).elements.getElement(id);
    return (el === undefined) ? [] : el.getToolTipMessage();
  }

  /** Send a view thumbnail to the frontend. This is a binary transfer with the metadata in a 16-byte prefix header. */
  public async getViewThumbnail(tokenProps: IModelRpcProps, viewId: string): Promise<Uint8Array> {
    const thumbnail = IModelDb.findByKey(tokenProps.key).views.getThumbnail(viewId);
    if (undefined === thumbnail || 0 === thumbnail.image.length)
      return Promise.reject(new Error("no thumbnail"));

    const val = new Uint8Array(thumbnail.image.length + 16); // allocate a new buffer 16 bytes larger than the image size
    new Uint32Array(val.buffer, 0, 4).set([thumbnail.image.length, thumbnail.format === "jpeg" ? ImageSourceFormat.Jpeg : ImageSourceFormat.Png, thumbnail.width, thumbnail.height]);    // Put the metadata in the first 16 bytes.
    val.set(thumbnail.image, 16); // put the image data at offset 16 after metadata
    return val;
  }

  public async getDefaultViewId(tokenProps: IModelRpcProps): Promise<Id64String> {
    const spec = { namespace: "dgn_View", name: "DefaultView" };
    const blob = IModelDb.findByKey(tokenProps.key).queryFilePropertyBlob(spec);
    if (undefined === blob || 8 !== blob.length)
      return Id64.invalid;

    const view = new Uint32Array(blob.buffer);
    return Id64.fromUint32Pair(view[0], view[1]);
  }
  public async getSpatialCategoryId(tokenProps: IModelRpcProps, categoryName: string): Promise<Id64String | undefined> {
    const iModelDb = IModelDb.findByKey(tokenProps.key);
    const dictionary: DictionaryModel = iModelDb.models.getModel(IModel.dictionaryId) as DictionaryModel;
    return SpatialCategory.queryCategoryIdByName(iModelDb, dictionary.id, categoryName);
  }

  public async getIModelCoordinatesFromGeoCoordinates(tokenProps: IModelRpcProps, props: string): Promise<IModelCoordinatesResponseProps> {
    const iModelDb = IModelDb.findByKey(tokenProps.key);
    const requestContext = ClientRequestContext.current;
    return iModelDb.getIModelCoordinatesFromGeoCoordinates(requestContext, props);
  }

  public async getGeoCoordinatesFromIModelCoordinates(tokenProps: IModelRpcProps, props: string): Promise<GeoCoordinatesResponseProps> {
    const iModelDb = IModelDb.findByKey(tokenProps.key);
    const requestContext = ClientRequestContext.current;
    return iModelDb.getGeoCoordinatesFromIModelCoordinates(requestContext, props);
  }
}
