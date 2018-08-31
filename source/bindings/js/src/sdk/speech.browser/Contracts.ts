//
// copyright (c) Microsoft. All rights reserved.
// licensed under the MIT license. See LICENSE.md file in the project root for full license information.
//
import { ArgumentNullError } from "../../common/Error";

export class Contracts {
    public static throwIfNullOrUndefined(param: any, name: string): void {
        if (param === undefined || param === null) {
            throw new ArgumentNullError(name);
        }
    }

    public static throwIfNull(param: any, name: string): void {
        if (param === null) {
            throw new ArgumentNullError(name);
        }
    }

    public static throwIfNullOrWhitespace(param: string, name: string): void {
        Contracts.throwIfNullOrUndefined(param, name);

        if (("" + param).trim().length < 1) {
            throw new ArgumentNullError(name);
        }
    }

    public static throwIfDisposed(isDisposed: boolean): void {
        if (isDisposed) {
            throw new ArgumentNullError("the object is already disposed");
        }
    }

    public static throwIfArrayEmptyOrWhitespace(array: string[], name: string): void {
        Contracts.throwIfNullOrUndefined(array, name);

        if (array.length === 0) {
            throw new ArgumentNullError(name);
        }

        for (const item of array) {
            Contracts.throwIfNullOrWhitespace(item, name);
        }
    }
}
