/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import * as React from "react";
import {
  CoreTools, ContentGroup, ContentControl, ConfigurableCreateInfo,
  FrontstageProvider, FrontstageProps, Frontstage, SignIn,
} from "@bentley/ui-framework";
import { SampleAppIModelApp } from "../../index";
import { IModelApp } from "@bentley/imodeljs-frontend";
import { isFrontendAuthorizationClient } from "@bentley/frontend-authorization-client";

class SignInControl extends ContentControl {
  constructor(info: ConfigurableCreateInfo, options: any) {
    super(info, options);

    const oidcClient = IModelApp.authorizationClient;
    if (isFrontendAuthorizationClient(oidcClient))
      this.reactNode = <SignIn onOffline={this._onWorkOffline} onRegister={this._onRegister} />;
    else
      this.reactNode = null;
  }

  // user chose to work offline from the sign in page
  private _onWorkOffline = async () => {
    await SampleAppIModelApp.handleWorkOffline();
  }

  private _onRegister = () => {
    window.open("https://www.imodeljs.org/getting-started/#developer-registration", "_blank");
  }
}

export class SignInFrontstage extends FrontstageProvider {

  public get frontstage(): React.ReactElement<FrontstageProps> {
    const contentGroup: ContentGroup = new ContentGroup({
      contents: [
        {
          classId: SignInControl,
        },
      ],
    });

    return (
      <Frontstage id="SignIn"
        defaultTool={CoreTools.selectElementCommand}
        defaultLayout="SingleContent"
        contentGroup={contentGroup}
        isInFooterMode={false}
      />
    );
  }
}