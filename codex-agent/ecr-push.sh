#!/bin/bash

# Exit on any error
set -e

# Default Configuration
REPOSITORY_NAME="codex-agent-server"
IMAGE_TAG="latest"
CREATE_REPO=false
UPDATE_TASK_DEF=true
TASK_DEFINITION_FAMILY="codex-agent-server"
CONTAINER_NAME_IN_TASK_DEF="codex-server"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Help message
show_help() {
    echo "Usage: $0 [options]"
    echo
    echo "Options:"
    echo "  -r, --repository REPOSITORY_NAME  Specify ECR repository name (default: ${REPOSITORY_NAME})"
    echo "  -n, --no-create-repo            Do not create repository if it doesn't exist"
    echo "  -u, --update-ecs-task-def       Update ECS task definition after push"
    echo "  -f, --ecs-task-family TASK_DEF_FAMILY  ECS task definition family to update (required if --update-ecs-task-def)"
    echo "  -c, --ecs-container-name CONTAINER_NAME   Container name in task definition to update (required if --update-ecs-task-def)"
    echo "  -h, --help                      Show this help message"
    exit 0
}

# Parse command line arguments
#transform long options to short ones
for arg in "$@"; do
  shift
  case "$arg" in
    "--help") set -- "$@" "-h" ;;
    "--repository") set -- "$@" "-r" ;;
    "--no-create-repo") set -- "$@" "-n" ;;
    "--update-ecs-task-def") set -- "$@" "-u" ;;
    "--ecs-task-family") set -- "$@" "-f" ;;
    "--ecs-container-name") set -- "$@" "-c" ;;
    *) set -- "$@" "$arg"
  esac
done

# Check for invalid combinations or missing arguments before getopts
for ((i=1; i<=$#; i++)); do
    current_arg="${!i}"
    next_arg_index=$((i+1))
    next_arg="${!next_arg_index}"

    if [[ "$current_arg" == "-u" || "$current_arg" == "--update-ecs-task-def" ]]; then
        # Check if -f and -c are also present
        has_f=false
        has_c=false
        for arg_check in "$@"; do
            if [[ "$arg_check" == "-f" || "$arg_check" == "--ecs-task-family" ]]; then
                has_f=true
            fi
            if [[ "$arg_check" == "-c" || "$arg_check" == "--ecs-container-name" ]]; then
                has_c=true
            fi
        done
        if ! $has_f || ! $has_c; then
            echo "Error: When using -u or --update-ecs-task-def, you must also provide -f/--ecs-task-family AND -c/--ecs-container-name." >&2
            show_help
        fi
    fi

    # Check if options requiring arguments have them
    if [[ "$current_arg" == "-r" || "$current_arg" == "--repository" || \
          "$current_arg" == "-f" || "$current_arg" == "--ecs-task-family" || \
          "$current_arg" == "-c" || "$current_arg" == "--ecs-container-name" ]]; then
        if [[ -z "$next_arg" ]] || [[ "$next_arg" == -* ]]; then
            echo "Error: Option $current_arg requires an argument." >&2
            show_help
        fi
    fi
done

#Original getopts
while getopts ":r:nf:c:hu" opt; do
    case $opt in
        r)
            REPOSITORY_NAME="$OPTARG"
            ;;
        n)
            CREATE_REPO=false
            ;;
        u)
            UPDATE_TASK_DEF=true
            ;;
        f)
            TASK_DEFINITION_FAMILY="$OPTARG"
            ;;
        c)
            CONTAINER_NAME_IN_TASK_DEF="$OPTARG"
            ;;
        h)
            show_help
            ;;
        \?)
            echo "Invalid option: -$OPTARG" >&2
            show_help
            ;;
        :)
            echo "Option -$OPTARG requires an argument." >&2
            show_help
            ;;
    esac
done

# Further validation for -u dependencies (if not caught by the loop above, e.g. if only short options used)
if [ "$UPDATE_TASK_DEF" = true ]; then
    if [ -z "$TASK_DEFINITION_FAMILY" ]; then
        print_message $RED "Task definition family (-f or --ecs-task-family) not specified but is required for ECS update."
        show_help
    fi
    if [ -z "$CONTAINER_NAME_IN_TASK_DEF" ]; then
        print_message $RED "Container name (-c or --ecs-container-name) not specified but is required for ECS update."
        show_help
    fi
fi

# Print with color
print_message() {
    color=$1
    message=$2
    printf "${color}${message}${NC}\n"
}

# Check if AWS CLI is installed
check_aws_cli() {
    if ! command -v aws &> /dev/null; then
        print_message $RED "AWS CLI is not installed. Please install it first."
        exit 1
    fi
}

# Check if jq is installed
check_jq() {
    if ! command -v jq &> /dev/null; then
        print_message $RED "jq is not installed. It is required for updating ECS task definition. Please install jq."
        exit 1
    fi
}

# Get AWS account details
get_aws_details() {
    print_message $YELLOW "Getting AWS account details..."
    export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    if [ -z "$AWS_REGION" ]; then
        export AWS_REGION=$(aws configure get region)
    fi
    
    if [ -z "$AWS_REGION" ]; then
        print_message $RED "AWS region not set. Please set AWS_REGION environment variable."
        exit 1
    fi
    
    print_message $GREEN "AWS Account ID: $AWS_ACCOUNT_ID"
    print_message $GREEN "AWS Region: $AWS_REGION"
    print_message $GREEN "Repository: $REPOSITORY_NAME"
}

# Create ECR repository if it doesn't exist
create_ecr_repository() {
    if [ "$CREATE_REPO" = true ]; then
        print_message $YELLOW "Creating ECR repository if it doesn't exist..."
        aws ecr describe-repositories --repository-names ${REPOSITORY_NAME} 2>/dev/null || \
        aws ecr create-repository --repository-name ${REPOSITORY_NAME} --region ${AWS_REGION}
    else
        print_message $YELLOW "Skipping repository creation..."
        # Check if repository exists
        if ! aws ecr describe-repositories --repository-names ${REPOSITORY_NAME} 2>/dev/null; then
            print_message $RED "Repository ${REPOSITORY_NAME} does not exist. Use without -n flag to create it."
            exit 1
        fi
    fi
}

# Authenticate Docker with ECR
authenticate_docker() {
    print_message $YELLOW "Authenticating Docker with ECR..."
    aws ecr get-login-password --region ${AWS_REGION} | \
    docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
}

# Build Docker image
build_image() {
    print_message $YELLOW "Building Docker image for linux/amd64 platform..."
    # Use docker buildx to build for a specific platform
    # --load ensures the image is loaded into the local Docker daemon for subsequent tagging and pushing
    if ! docker buildx build --platform linux/amd64 -t ${REPOSITORY_NAME}:${IMAGE_TAG} --load . ; then
        print_message $RED "Docker buildx failed. Ensure buildx is available and working."
        print_message $RED "You might need to run: docker buildx create --use"
        exit 1
    fi
}

# Tag and push image to ECR
push_to_ecr() {
    print_message $YELLOW "Tagging and pushing image to ECR..."
    docker tag ${REPOSITORY_NAME}:${IMAGE_TAG} ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPOSITORY_NAME}:${IMAGE_TAG}
    docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPOSITORY_NAME}:${IMAGE_TAG}
}

# Update ECS Task Definition
update_ecs_task_definition() {
    print_message $YELLOW "Updating ECS task definition..."

    if [ -z "$TASK_DEFINITION_FAMILY" ]; then
        print_message $RED "Task definition family (-f) not specified. Cannot update."
        exit 1
    fi
    if [ -z "$CONTAINER_NAME_IN_TASK_DEF" ]; then
        print_message $RED "Container name (-c) not specified. Cannot update."
        exit 1
    fi

    NEW_IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPOSITORY_NAME}:${IMAGE_TAG}"
    print_message $YELLOW "New image URI: $NEW_IMAGE_URI"
    print_message $YELLOW "Fetching current task definition for family: $TASK_DEFINITION_FAMILY..."

    CURRENT_TASK_DEF_JSON=$(aws ecs describe-task-definition --task-definition "$TASK_DEFINITION_FAMILY" --query taskDefinition)
    if [ -z "$CURRENT_TASK_DEF_JSON" ]; then
        print_message $RED "Failed to fetch current task definition for family: $TASK_DEFINITION_FAMILY"
        exit 1
    fi

    print_message $YELLOW "Fetched task definition JSON:"
    echo "$CURRENT_TASK_DEF_JSON"
    print_message $YELLOW "------------------------------------"

    # Create a temporary file for the new task definition input
    NEW_TASK_DEF_INPUT_FILE=$(mktemp)
    
    print_message $YELLOW "Preparing to execute jq..."

    # Use jq to update the container image and select relevant fields for register-task-definition
    # Pass sensitive values as environment variables or arguments to jq
    echo "$CURRENT_TASK_DEF_JSON" | jq \
        --arg p_container_name "$CONTAINER_NAME_IN_TASK_DEF" \
        --arg p_new_image_uri "$NEW_IMAGE_URI" \
        '
        # Update container image
        (.containerDefinitions[] | select(.name == $p_container_name) | .image) |= $p_new_image_uri |
        # Construct the object for register-task-definition
        {
            family: .family,
            containerDefinitions: .containerDefinitions
        } +
        # Add optional fields only if they exist (not null) in the source
        (if .taskRoleArn then {taskRoleArn: .taskRoleArn} else {} end) +
        (if .executionRoleArn then {executionRoleArn: .executionRoleArn} else {} end) +
        (if .networkMode then {networkMode: .networkMode} else {} end) +
        (if .volumes then {volumes: .volumes} else {} end) + # volumes can be an empty array
        (if .placementConstraints then {placementConstraints: .placementConstraints} else {} end) +
        (if .requiresCompatibilities then {requiresCompatibilities: .requiresCompatibilities} else {} end) +
        (if .cpu then {cpu: .cpu} else {} end) +
        (if .memory then {memory: .memory} else {} end) +
        (if .tags then {tags: .tags} else {} end) + # tags can be an empty array
        (if .pidMode then {pidMode: .pidMode} else {} end) +
        (if .ipcMode then {ipcMode: .ipcMode} else {} end) +
        (if .proxyConfiguration then {proxyConfiguration: .proxyConfiguration} else {} end) +
        (if .inferenceAccelerators then {inferenceAccelerators: .inferenceAccelerators} else {} end) +
        (if .ephemeralStorage then {ephemeralStorage: .ephemeralStorage} else {} end) +
        (if .runtimePlatform then {runtimePlatform: .runtimePlatform} else {} end)
        ' > "$NEW_TASK_DEF_INPUT_FILE"

    if [ ! -s "$NEW_TASK_DEF_INPUT_FILE" ]; then
        print_message $RED "Failed to generate new task definition JSON using jq."
        rm "$NEW_TASK_DEF_INPUT_FILE"
        exit 1
    fi
    
    print_message $YELLOW "Registering new task definition revision..."
    NEW_TASK_DEF_ARN=$(aws ecs register-task-definition --cli-input-json "file://${NEW_TASK_DEF_INPUT_FILE}" --query taskDefinition.taskDefinitionArn --output text)
    
    rm "$NEW_TASK_DEF_INPUT_FILE"

    if [ -n "$NEW_TASK_DEF_ARN" ]; then
        print_message $GREEN "Successfully registered new task definition revision: $NEW_TASK_DEF_ARN"
        print_message $YELLOW "Note: To deploy this new revision, you may need to update your ECS service(s) to use this new task definition ARN."
        print_message $YELLOW "Example: aws ecs update-service --cluster <your-cluster> --service <your-service> --task-definition $NEW_TASK_DEF_ARN"
    else
        print_message $RED "Failed to register new task definition revision."
        exit 1
    fi
}

# Main execution
main() {
    print_message $YELLOW "Starting ECR push process..."
    
    check_aws_cli
    get_aws_details
    create_ecr_repository
    authenticate_docker
    build_image
    push_to_ecr
    
    print_message $GREEN "\nSuccess! Image pushed to ECR repository:"
    print_message $GREEN "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPOSITORY_NAME}:${IMAGE_TAG}"

    if [ "$UPDATE_TASK_DEF" = true ]; then
        check_jq
        update_ecs_task_definition
    fi
}

# Run main function
main 