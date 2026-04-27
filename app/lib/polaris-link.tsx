import { Link as ReactRouterLink } from "react-router";
import type { LinkLikeComponentProps } from "@shopify/polaris/build/ts/src/utilities/link/types";

export function PolarisLink({ url, external, ref, ...rest }: LinkLikeComponentProps) {
  if (external) {
    return <a href={url} target="_blank" rel="noopener noreferrer" {...rest} />;
  }
  return <ReactRouterLink to={url} {...rest} />;
}