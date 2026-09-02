package com.rockbenben.shiye;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * **自写插件唯一的接线点。** `npx cap sync` 生成的
     * assets/capacitor.plugins.json 是从 npm 包的 `capacitor.android` 字段
     * 算出来的，自写插件不是 npm 包、不在里面，也就没人替你注册
     * ——scripts/capacitor-plugins-wired.test.ts 那道守卫同理盖不到它，
     * 守它的是 scripts/share-target-wired.test.ts。
     *
     * **必须排在 super.onCreate() 之前**：registerPlugin() 往
     * BridgeActivity 的 bridgeBuilder 里加（那是个 inline 初始化的 final
     * 字段，BridgeActivity.java:19，onCreate 之前就有了），而 bridge 是在
     * super.onCreate() 里 build 出来的（BridgeActivity.java:42 → load() 的
     * :48）——晚一步这个插件就不在里面了。
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareTargetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
