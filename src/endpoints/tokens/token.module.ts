import { forwardRef, Module } from "@nestjs/common";
import { CommonModule } from "src/common/common.module";
import { EsdtModule } from "../esdt/esdt.module";
import { TransactionModule } from "../transactions/transaction.module";
import { TokenAssetService } from "./token.asset.service";
import { TokenService } from "./token.service";

@Module({
  imports: [
    forwardRef(() => CommonModule),
    forwardRef(() => EsdtModule),
    forwardRef(() => TransactionModule),
  ],
  providers: [
    TokenAssetService, TokenService
  ],
  exports: [
    TokenAssetService, TokenService
  ]
})
export class TokenModule { }