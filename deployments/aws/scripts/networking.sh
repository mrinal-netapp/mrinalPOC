#!/usr/bin/env bash
# Create AgentStudio VPC and subnets from required CIDR env vars (see runbook Step 1).
# Prints export statements only on stdout — use: eval "$(./deployments/aws/scripts/networking.sh)"
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION}"
: "${CLUSTER_NAME:?Set CLUSTER_NAME}"
: "${VPC_CIDR:?Set VPC_CIDR}"
: "${VPC_NAME:?Set VPC_NAME}"
: "${PUBLIC_1_CIDR:?Set PUBLIC_1_CIDR}"
: "${PUBLIC_2_CIDR:?Set PUBLIC_2_CIDR}"
: "${PRIVATE_SUBNET_1_CIDR:?Set PRIVATE_SUBNET_1_CIDR}"
: "${PRIVATE_SUBNET_2_CIDR:?Set PRIVATE_SUBNET_2_CIDR}"
: "${FSX_SUBNET_CIDR:?Set FSX_SUBNET_CIDR}"

export AWS_PAGER=""

AZ1=$(aws ec2 describe-availability-zones --region "$AWS_REGION" \
  --query 'AvailabilityZones[?State==`available`].ZoneName | [0]' --output text)
AZ2=$(aws ec2 describe-availability-zones --region "$AWS_REGION" \
  --query 'AvailabilityZones[?State==`available`].ZoneName | [1]' --output text)
[[ -n "$AZ1" && -n "$AZ2" && "$AZ1" != "None" && "$AZ2" != "None" ]] || { echo "Need at least 2 AZs in ${AWS_REGION}" >&2; exit 1; }

VPC_ID=$(aws ec2 create-vpc --region "$AWS_REGION" --cidr-block "$VPC_CIDR" \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${VPC_NAME}}]" \
  --query 'Vpc.VpcId' --output text)
aws ec2 modify-vpc-attribute --region "$AWS_REGION" --vpc-id "$VPC_ID" --enable-dns-hostnames >/dev/null
aws ec2 modify-vpc-attribute --region "$AWS_REGION" --vpc-id "$VPC_ID" --enable-dns-support >/dev/null

IGW=$(aws ec2 create-internet-gateway --region "$AWS_REGION" \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${VPC_NAME}-igw}]" \
  --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --region "$AWS_REGION" --internet-gateway-id "$IGW" --vpc-id "$VPC_ID" >/dev/null

create_subnet() {
  local cidr="$1" az="$2" name="$3"
  aws ec2 create-subnet --region "$AWS_REGION" --vpc-id "$VPC_ID" \
    --availability-zone "$az" --cidr-block "$cidr" \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${name}}]" \
    --query 'Subnet.SubnetId' --output text
}

PUBLIC_SUBNET_1=$(create_subnet "$PUBLIC_1_CIDR" "$AZ1" "${VPC_NAME}-public-${AZ1}")
PUBLIC_SUBNET_2=$(create_subnet "$PUBLIC_2_CIDR" "$AZ2" "${VPC_NAME}-public-${AZ2}")
PRIVATE_SUBNET_1=$(create_subnet "$PRIVATE_SUBNET_1_CIDR" "$AZ1" "${VPC_NAME}-private-eks-${AZ1}")
PRIVATE_SUBNET_2=$(create_subnet "$PRIVATE_SUBNET_2_CIDR" "$AZ2" "${VPC_NAME}-private-eks-${AZ2}")
FSX_SUBNET_ID=$(create_subnet "$FSX_SUBNET_CIDR" "$AZ1" "${VPC_NAME}-private-fsx-${AZ1}")

aws ec2 modify-subnet-attribute --region "$AWS_REGION" --subnet-id "$PUBLIC_SUBNET_1" --map-public-ip-on-launch >/dev/null
aws ec2 modify-subnet-attribute --region "$AWS_REGION" --subnet-id "$PUBLIC_SUBNET_2" --map-public-ip-on-launch >/dev/null

RTB_PUBLIC=$(aws ec2 create-route-table --region "$AWS_REGION" --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${VPC_NAME}-public}]" \
  --query 'RouteTable.RouteTableId' --output text)
RTB_PRIVATE=$(aws ec2 create-route-table --region "$AWS_REGION" --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${VPC_NAME}-private}]" \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --region "$AWS_REGION" --route-table-id "$RTB_PUBLIC" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" >/dev/null

for sn in "$PUBLIC_SUBNET_1" "$PUBLIC_SUBNET_2"; do
  aws ec2 associate-route-table --region "$AWS_REGION" --subnet-id "$sn" --route-table-id "$RTB_PUBLIC" >/dev/null
done

EIP=$(aws ec2 allocate-address --region "$AWS_REGION" --domain vpc --query AllocationId --output text)
NAT=$(aws ec2 create-nat-gateway --region "$AWS_REGION" --subnet-id "$PUBLIC_SUBNET_1" \
  --allocation-id "$EIP" \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=${VPC_NAME}-nat}]" \
  --query 'NatGateway.NatGatewayId' --output text)
aws ec2 wait nat-gateway-available --region "$AWS_REGION" --nat-gateway-ids "$NAT"

aws ec2 create-route --region "$AWS_REGION" --route-table-id "$RTB_PRIVATE" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT" >/dev/null

for sn in "$PRIVATE_SUBNET_1" "$PRIVATE_SUBNET_2" "$FSX_SUBNET_ID"; do
  aws ec2 associate-route-table --region "$AWS_REGION" --subnet-id "$sn" --route-table-id "$RTB_PRIVATE" >/dev/null
done

tag_eks() {
  local sn="$1" elb_role="$2"
  aws ec2 create-tags --region "$AWS_REGION" --resources "$sn" \
    --tags "Key=kubernetes.io/cluster/${CLUSTER_NAME},Value=shared" \
           "Key=${elb_role},Value=1" >/dev/null
}

tag_eks "$PRIVATE_SUBNET_1" "kubernetes.io/role/internal-elb"
tag_eks "$PRIVATE_SUBNET_2" "kubernetes.io/role/internal-elb"
tag_eks "$PUBLIC_SUBNET_1" "kubernetes.io/role/elb"
tag_eks "$PUBLIC_SUBNET_2" "kubernetes.io/role/elb"

echo "export AWS_REGION=${AWS_REGION}" >&2
echo "Created VPC ${VPC_ID} in ${AWS_REGION}" >&2

cat <<EOF
export AWS_REGION=${AWS_REGION}
export CLUSTER_NAME=${CLUSTER_NAME}
export VPC_ID=${VPC_ID}
export VPC_CIDR=${VPC_CIDR}
export PUBLIC_SUBNET_1=${PUBLIC_SUBNET_1}
export PUBLIC_SUBNET_2=${PUBLIC_SUBNET_2}
export PRIVATE_SUBNET_1=${PRIVATE_SUBNET_1}
export PRIVATE_SUBNET_2=${PRIVATE_SUBNET_2}
export PRIVATE_SUBNET_1_CIDR=${PRIVATE_SUBNET_1_CIDR}
export PRIVATE_SUBNET_2_CIDR=${PRIVATE_SUBNET_2_CIDR}
export FSX_SUBNET_ID=${FSX_SUBNET_ID}
export FSX_SUBNET_CIDR=${FSX_SUBNET_CIDR}
export PRIVATE_ROUTE_TABLE_ID=${RTB_PRIVATE}
EOF
