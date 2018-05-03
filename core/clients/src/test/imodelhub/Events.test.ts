/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import * as chai from "chai";
import * as utils from "./TestUtils";

import { TestConfig } from "../TestConfig";

import { Guid } from "@bentley/bentleyjs-core";
import { EventSubscription, CodeEvent, EventSAS, EventType } from "../../imodelhub";
import { IModelHubClient } from "../../imodelhub/Client";
import { AccessToken } from "../../Token";
import { ResponseBuilder, RequestType, ScopeType } from "../ResponseBuilder";
import { AzureFileHandler } from "../../imodelhub/AzureFileHandler";

chai.should();

function mockCreateEventSubscription(responseBuilder: ResponseBuilder, imodelId: string, eventTypes: EventType[]) {
  if (!TestConfig.enableMocks)
    return;

  const requestPath = utils.createRequestUrl(ScopeType.iModel, imodelId, "EventSubscription");
  const requestResponse = responseBuilder.generatePostResponse<EventSubscription>(responseBuilder.generateObject<EventSubscription>(EventSubscription,
    new Map<string, any>([
      ["wsgId", Guid.createValue()],
      ["eventTypes", eventTypes],
    ])));
  const postBody = responseBuilder.generatePostBody<EventSubscription>(responseBuilder.generateObject<EventSubscription>(EventSubscription,
    new Map<string, any>([
      ["eventTypes", eventTypes],
    ])));
  responseBuilder.mockResponse(utils.defaultUrl, RequestType.Post, requestPath, requestResponse, 1, postBody);
}

function mockGetEventSASToken(responseBuilder: ResponseBuilder, imodelId: string) {
  if (!TestConfig.enableMocks)
    return;

  const requestPath = utils.createRequestUrl(ScopeType.iModel, imodelId, "EventSAS");
  const responseObject = responseBuilder.generateObject<EventSAS>(EventSAS,
    new Map<string, any>([
      ["sasToken", Guid.createValue()],
      ["baseAddres", `https://qa-imodelhubapi.bentley.com/v2.5/Repositories/iModel--${imodelId}/iModelScope`],
    ]));
  const requestResponse = responseBuilder.generatePostResponse<EventSAS>(responseObject);
  const postBody = responseBuilder.generatePostBody<EventSAS>(responseBuilder.generateObject<EventSAS>(EventSAS));
  responseBuilder.mockResponse(utils.defaultUrl, RequestType.Post, requestPath, requestResponse, 1, postBody);
}

function mockGetEvent(responseBuilder: ResponseBuilder, imodelId: string, subscriptionId: string, eventBody: string) {
  if (!TestConfig.enableMocks)
    return;

  const requestPath = utils.createRequestUrl(ScopeType.iModel, imodelId, "Subscriptions", subscriptionId + "/messages/head");
  responseBuilder.mockResponse(utils.defaultUrl, RequestType.Delete, requestPath, eventBody, 1, "", {"content-type": "CodeEvent"});
}

function mockDeleteEventSubscription(responseBuilder: ResponseBuilder, imodelId: string, subscriptionId: string) {
  if (!TestConfig.enableMocks)
    return;

  const requestPath = utils.createRequestUrl(ScopeType.iModel, imodelId, "EventSubscription", subscriptionId);
  responseBuilder.mockResponse(utils.defaultUrl, RequestType.Delete, requestPath, "");
}

describe("iModelHub EventHandler", () => {
  let accessToken: AccessToken;
  let iModelId: string;
  let subscription: EventSubscription;
  const imodelHubClient: IModelHubClient = new IModelHubClient(TestConfig.deploymentEnv, new AzureFileHandler());
  const responseBuilder: ResponseBuilder = new ResponseBuilder();

  before(async () => {
    accessToken = await utils.login();
    iModelId = await utils.getIModelId(accessToken);
  });

  afterEach(() => {
    responseBuilder.clearMocks();
  });

  it("should subscribe to event subscription", async () => {
    const eventTypes: EventType[] = ["CodeEvent"];
    mockCreateEventSubscription(responseBuilder, iModelId, eventTypes);

    subscription = await imodelHubClient.Events().Subscriptions().create(accessToken, iModelId, eventTypes);
    chai.expect(subscription);
  });

  it("should receive code event", async () => {
    // This test attempts to receive at least one code event generated by the test above
    mockGetEventSASToken(responseBuilder, iModelId);
    const sas = await imodelHubClient.Events().getSASToken(accessToken, iModelId);

    if (!TestConfig.enableMocks) {
      const briefcases = await imodelHubClient.Briefcases().get(accessToken, iModelId);
      const briefcaseId = parseInt(briefcases[0].wsgId, undefined);
      await imodelHubClient.Codes().update(accessToken, iModelId, [utils.randomCode(briefcaseId)]);
    }

    const requestResponse = '{"EventTopic":"123","FromEventSubscriptionId":"456","ToEventSubscriptionId":"","BriefcaseId":1,"CodeScope":"0X100000000FF","CodeSpecId":"0xff","State":1,"Values":["TestCode143678383"]}';
    mockGetEvent(responseBuilder, iModelId, subscription.wsgId, requestResponse);
    const event = await imodelHubClient.Events().getEvent(sas.sasToken!, sas.baseAddres!, subscription.wsgId);

    mockDeleteEventSubscription(responseBuilder, iModelId, subscription.wsgId);
    await imodelHubClient.Events().Subscriptions().delete(accessToken, iModelId, subscription.wsgId);
    chai.expect(event).instanceof(CodeEvent);
  });
});
