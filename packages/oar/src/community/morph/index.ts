import type { RuntimeBrand } from "../../contracts/brand.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { morphInstallation } from "./installation.js";
import { morphListModels } from "./list-models.js";
import { morphRefusedSessionOptions, morphSession } from "./session.js";

/** The Mister Morph mark (assets/brands/morph*.svg; see assets/brands/NOTICE.md). */
export const morphBrand: RuntimeBrand = {
  name: "Mister Morph",
  icon: `data:image/svg+xml,${encodeURIComponent("<svg width=\"512\" height=\"512\" viewBox=\"0 0 512 512\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M256 42C374.189 42 470 137.811 470 256C470 374.189 374.189 470 256 470C137.811 470 42 374.189 42 256C42 137.811 137.811 42 256 42ZM256 56C145.543 56 56 145.543 56 256C56 366.457 145.543 456 256 456C366.457 456 456 366.457 456 256C456 145.543 366.457 56 256 56Z\" fill=\"#1F1F1F\"/>\n<circle cx=\"256\" cy=\"256\" r=\"160\" fill=\"#1F1F1F\"/>\n<path d=\"M256 96C344.366 96 416 167.634 416 256C416 344.366 344.366 416 256 416C167.634 416 96 344.366 96 256C96 167.634 167.634 96 256 96ZM256 116C178.68 116 116 178.68 116 256C116 333.32 178.68 396 256 396C333.32 396 396 333.32 396 256C396 178.68 333.32 116 256 116Z\" fill=\"#1F1F1F\"/>\n<circle cx=\"318\" cy=\"255\" r=\"19.5\" fill=\"white\" stroke=\"white\"/>\n<circle cx=\"191\" cy=\"255\" r=\"19.5\" fill=\"white\" stroke=\"white\"/>\n<path d=\"M233.5 282.5C235.333 287.167 242.4 296.5 256 296.5C269.6 296.5 276.333 287.167 278 282.5\" stroke=\"white\" stroke-width=\"12\" stroke-linecap=\"round\"/>\n<path d=\"M264 466H248V412H264V466ZM132 355.188L95.3662 381.321L86.0742 368.296L122.708 342.162L132 355.188ZM427.279 368.134L417.987 381.159L381.354 355.025L390.646 342L427.279 368.134ZM428.926 151.025L392.292 177.159L383 164.134L419.634 138L428.926 151.025ZM129.279 161.134L119.987 174.159L83.3545 148.025L92.6465 135L129.279 161.134ZM264 97H248V51H264V97Z\" fill=\"#1F1F1F\"/>\n</svg>\n")}`,
  icons: {
    light: `data:image/svg+xml,${encodeURIComponent("<svg width=\"512\" height=\"512\" viewBox=\"0 0 512 512\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M256 42C374.189 42 470 137.811 470 256C470 374.189 374.189 470 256 470C137.811 470 42 374.189 42 256C42 137.811 137.811 42 256 42ZM256 56C145.543 56 56 145.543 56 256C56 366.457 145.543 456 256 456C366.457 456 456 366.457 456 256C456 145.543 366.457 56 256 56Z\" fill=\"#1F1F1F\"/>\n<circle cx=\"256\" cy=\"256\" r=\"160\" fill=\"#1F1F1F\"/>\n<path d=\"M256 96C344.366 96 416 167.634 416 256C416 344.366 344.366 416 256 416C167.634 416 96 344.366 96 256C96 167.634 167.634 96 256 96ZM256 116C178.68 116 116 178.68 116 256C116 333.32 178.68 396 256 396C333.32 396 396 333.32 396 256C396 178.68 333.32 116 256 116Z\" fill=\"#1F1F1F\"/>\n<circle cx=\"318\" cy=\"255\" r=\"19.5\" fill=\"white\" stroke=\"white\"/>\n<circle cx=\"191\" cy=\"255\" r=\"19.5\" fill=\"white\" stroke=\"white\"/>\n<path d=\"M233.5 282.5C235.333 287.167 242.4 296.5 256 296.5C269.6 296.5 276.333 287.167 278 282.5\" stroke=\"white\" stroke-width=\"12\" stroke-linecap=\"round\"/>\n<path d=\"M264 466H248V412H264V466ZM132 355.188L95.3662 381.321L86.0742 368.296L122.708 342.162L132 355.188ZM427.279 368.134L417.987 381.159L381.354 355.025L390.646 342L427.279 368.134ZM428.926 151.025L392.292 177.159L383 164.134L419.634 138L428.926 151.025ZM129.279 161.134L119.987 174.159L83.3545 148.025L92.6465 135L129.279 161.134ZM264 97H248V51H264V97Z\" fill=\"#1F1F1F\"/>\n</svg>\n")}`,
    dark: `data:image/svg+xml,${encodeURIComponent("<svg width=\"512\" height=\"512\" viewBox=\"0 0 512 512\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M256 42C374.189 42 470 137.811 470 256C470 374.189 374.189 470 256 470C137.811 470 42 374.189 42 256C42 137.811 137.811 42 256 42ZM256 56C145.543 56 56 145.543 56 256C56 366.457 145.543 456 256 456C366.457 456 456 366.457 456 256C456 145.543 366.457 56 256 56Z\" fill=\"#FFFFFF\"/>\n<circle cx=\"256\" cy=\"256\" r=\"160\" fill=\"#FFFFFF\"/>\n<path d=\"M256 96C344.366 96 416 167.634 416 256C416 344.366 344.366 416 256 416C167.634 416 96 344.366 96 256C96 167.634 167.634 96 256 96ZM256 116C178.68 116 116 178.68 116 256C116 333.32 178.68 396 256 396C333.32 396 396 333.32 396 256C396 178.68 333.32 116 256 116Z\" fill=\"#FFFFFF\"/>\n<circle cx=\"318\" cy=\"255\" r=\"19.5\" fill=\"#1F1F1F\" stroke=\"#1F1F1F\"/>\n<circle cx=\"191\" cy=\"255\" r=\"19.5\" fill=\"#1F1F1F\" stroke=\"#1F1F1F\"/>\n<path d=\"M233.5 282.5C235.333 287.167 242.4 296.5 256 296.5C269.6 296.5 276.333 287.167 278 282.5\" stroke=\"#1F1F1F\" stroke-width=\"12\" stroke-linecap=\"round\"/>\n<path d=\"M264 466H248V412H264V466ZM132 355.188L95.3662 381.321L86.0742 368.296L122.708 342.162L132 355.188ZM427.279 368.134L417.987 381.159L381.354 355.025L390.646 342L427.279 368.134ZM428.926 151.025L392.292 177.159L383 164.134L419.634 138L428.926 151.025ZM129.279 161.134L119.987 174.159L83.3545 148.025L92.6465 135L129.279 161.134ZM264 97H248V51H264V97Z\" fill=\"#FFFFFF\"/>\n</svg>\n")}`,
  },
};

/** A morph runtime: its probe, model listing and refusals are always there. */
export type MorphRuntime = Runtime & Required<Pick<Runtime, "installation" | "listModels" | "refusedSessionOptions">>;

/**
 * Mister Morph, driven through its Console Runtime API
 * (docs/runtimes/morph.md). A community runtime: not in the built-in
 * `runtimes` registry; a host adds it with
 * `createRuntimeRegistry([...runtimes.list(), createMorphRuntime()])`.
 */
export function createMorphRuntime(): MorphRuntime {
  return defineRuntime({
    id: "morph",
    brand: morphBrand,
    installation: morphInstallation,
    listModels: morphListModels,
    session: morphSession,
    refusedSessionOptions: morphRefusedSessionOptions,
  });
}

export { projectMorphModels } from "./list-models.js";
