// Sign release builds with the developer's own key.
//
// The generated android/ project signs release APKs with the template's debug
// key, which is the same file in every React Native project. This adds a
// release signing config read from Gradle properties that live outside the
// repository (see README, "Build an APK"). When they are absent the build
// falls back to the debug key, so a fresh clone still builds.

const { withAppBuildGradle } = require('expo/config-plugins');

const STORE_FILE = 'LANCLAVE_RELEASE_STORE_FILE';

const RELEASE_CONFIG = `signingConfigs {
        release {
            if (project.hasProperty('${STORE_FILE}')) {
                storeFile file(project.property('${STORE_FILE}'))
                storePassword project.property('LANCLAVE_RELEASE_STORE_PASSWORD')
                keyAlias project.property('LANCLAVE_RELEASE_KEY_ALIAS')
                keyPassword project.property('LANCLAVE_RELEASE_KEY_PASSWORD')
            }
        }`;

const PICK_CONFIG = `signingConfig project.hasProperty('${STORE_FILE}') ? signingConfigs.release : signingConfigs.debug`;

function addReleaseSigning(gradle) {
  // Prebuild runs this against the file it patched last time.
  if (gradle.includes(STORE_FILE)) return gradle;

  const configs = /signingConfigs\s*\{/;
  const releaseUsesDebug = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!configs.test(gradle) || !releaseUsesDebug.test(gradle)) {
    throw new Error(
      'with-release-signing: android/app/build.gradle no longer looks like the template this plugin patches.',
    );
  }

  return gradle
    .replace(releaseUsesDebug, (_, before) => before + PICK_CONFIG)
    .replace(configs, RELEASE_CONFIG);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = addReleaseSigning(config.modResults.contents);
    return config;
  });
};
