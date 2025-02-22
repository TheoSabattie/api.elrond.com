import { ApiProperty } from "@nestjs/swagger";

export class Block {
    @ApiProperty()
    hash: string = '';

    @ApiProperty()
    epoch: number = 0;

    @ApiProperty()
    nonce: number = 0;

    @ApiProperty()
    prevHash: string = '';

    @ApiProperty()
    proposer: string = '';

    @ApiProperty()
    pubKeyBitmap: string = '';

    @ApiProperty()
    round: number = 0;

    @ApiProperty()
    shard: number = 0;

    @ApiProperty()
    size: number = 0;

    @ApiProperty()
    sizeTxs: number = 0;

    @ApiProperty()
    stateRootHash: string = '';

    @ApiProperty()
    timestamp: number = 0;

    @ApiProperty()
    txCount: number = 0;

    @ApiProperty()
    gasConsumed: number = 0;

    @ApiProperty()
    gasRefunded: number = 0;

    @ApiProperty()
    gasPenalized: number = 0;

    @ApiProperty()
    maxGasLimit: number = 0;
}