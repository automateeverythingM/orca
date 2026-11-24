export type CodemodeSettings = {
  /** Code mode: native-chat agents get a run_js tool that runs JavaScript in a QuickJS sandbox; absent means off. */
  codemodeEnabled?: boolean
}
